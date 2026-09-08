// Cinba's local core service.
//
// Pi lives here and so do the session ledgers, which makes this the single
// source of truth for what the UI should look like. The GUI and the web UI are
// both its clients, and from phase B so is the TUI.
//
// History itself is not ours: Pi writes every conversation to its own session
// files, and this service reads them back rather than keeping a store of its
// own. A ledger here is a projection of one of those files plus the part of the
// present that Pi has not written yet.
//
// It listens on 127.0.0.1 only. That is the sole reason this phase has no
// network attack surface, and it must never become 0.0.0.0: this service can
// run any command on this machine, so opening a door outward is a different
// order of problem and belongs to form C's later steps.
//
// Usage: node <repo>/packages/core-server/src/index.ts

import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findSession, listSessions as storedSessions, startCore } from "@cinba/core-host";
import {
  CoreClient,
  createEventFolder,
  createSession,
  foldSessionEntries,
  foldUiRequest,
  parseClientMessage,
  sameTranscript,
  StdioTransport,
} from "@cinba/core-client";
import type {
  ModelRef,
  ServerMessage,
  Session,
  SessionSummary,
  ViewAction,
} from "@cinba/core-client";

const HOST = "127.0.0.1";
const PORT = 4517;

/** Text deltas arrive token by token; batch them so each character is not its own round trip. */
const FLUSH_INTERVAL_MS = 30;

/** Where the built UI lives. Located relative to the repo layout, not through package resolution. */
const WEB_DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/** Serve the UI's static files. */
async function serveStatic(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;

  // Guard against path traversal: join first, then check the result is still
  // under WEB_DIST. We listen on loopback only today, but this check should be
  // in place before a channel is ever opened outward.
  const filePath = normalize(join(WEB_DIST, requested));
  if (!filePath.startsWith(WEB_DIST + sep) && filePath !== WEB_DIST) {
    response.writeHead(403).end("forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
    });
    response.end(body);
  } catch {
    response
      .writeHead(404)
      .end("The UI is not built yet. Run: npm run build --workspace @cinba/web");
  }
}

// ---- State ----

/**
 * One opened conversation: a Pi process, a ledger, and the confirmations it is
 * waiting on.
 *
 * Only opened sessions live here. The rest sit on disk as Pi session files and
 * cost nothing — starting a Pi for every stored conversation would mean dozens
 * of processes for a history that mostly nobody is looking at.
 */
type Live = {
  id: string;
  cwd: string;
  pi: CoreClient;
  ledger: Session;
  fold: (event: { type: string; [key: string]: unknown }) => ViewAction[];
  model: ModelRef | undefined;
  /** Confirmations belong to the conversation that raised them, not to the service. */
  pendingConfirms: Map<string, (confirmed: boolean) => void>;
  outbox: ViewAction[];
  flushTimer: NodeJS.Timeout | undefined;
  /** Everything Pi has stored so far, already folded. The authoritative telling of the past. */
  storedActions: ViewAction[];
  /** Last entry id pulled from Pi, so the next pull asks only for what followed. */
  reconciledUpTo: string | undefined;
};

const live = new Map<string, Live>();

/** Which conversation each client is looking at. Two clients may differ. */
const viewing = new Map<WebSocket, string>();

const clients = new Set<WebSocket>();

/** Defaults for a newly started Pi, and where to pick up on restart. */
let cwd = homedir();
let model: ModelRef | undefined;
let lastSessionId: string | undefined;

// ---- Remembering ----

const configDir = join(homedir(), ".cinba");

function configPath(): string {
  return join(configDir, "config.json");
}

function loadConfig(): void {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
    if (typeof parsed.cwd === "string" && existsSync(parsed.cwd)) cwd = parsed.cwd;
    if (typeof parsed.provider === "string" && typeof parsed.modelId === "string") {
      model = { provider: parsed.provider, id: parsed.modelId };
    }
    if (typeof parsed.lastSessionId === "string") lastSessionId = parsed.lastSessionId;
  } catch {
    // On first start the file does not exist, which is normal.
  }
}

function saveConfig(): void {
  try {
    mkdirSync(configDir, { recursive: true });
    const body = { cwd, provider: model?.provider, modelId: model?.id, lastSessionId };
    writeFileSync(configPath(), JSON.stringify(body, null, 2), "utf8");
  } catch {
    // Failing to remember does not affect this run, and is not worth interrupting the service for.
  }
}

// ---- Sending ----

function sendTo(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}

/** Send only to the clients looking at this conversation. */
function toViewers(sessionId: string, message: ServerMessage): void {
  const text = JSON.stringify(message);
  for (const [socket, id] of viewing) {
    if (id === sessionId) socket.send(text);
  }
}

/** Record into a ledger and queue for its viewers. */
function emit(session: Live, actions: ViewAction[]): void {
  if (actions.length === 0) return;
  for (const action of actions) session.ledger.apply(action);
  session.outbox.push(...actions);

  if (session.flushTimer) return;
  session.flushTimer = setTimeout(() => {
    session.flushTimer = undefined;
    const batch = session.outbox;
    session.outbox = [];
    if (batch.length > 0) toViewers(session.id, { type: "actions", actions: batch });
  }, FLUSH_INTERVAL_MS);
}

function snapshotOf(session: Live): ServerMessage {
  return {
    type: "snapshot",
    snapshot: session.ledger.snapshot(),
    cwd: session.cwd,
    sessionId: session.id,
    model: session.model,
  };
}

// ---- Sessions on disk ----

/** Every stored conversation, newest first, in the shape the wire wants. Starts no Pi. */
async function listSessions(forCwd?: string): Promise<SessionSummary[]> {
  const sessions = await storedSessions(forCwd);
  return sessions.map((session) => ({
    id: session.id,
    cwd: session.cwd,
    name: session.name,
    messageCount: session.messageCount,
    firstMessage: session.firstMessage,
    // A Date does not survive JSON.
    modified: session.modified.toISOString(),
  }));
}

// ---- Starting and stopping a Pi ----

/**
 * Bring a conversation to life: start its Pi, wire the event stream into its
 * ledger, and rebuild the transcript from what Pi has stored.
 */
async function open(options: { sessionPath?: string; cwd: string }): Promise<Live | undefined> {
  // A directory that has since been renamed or removed makes spawn fail with
  // ENOENT, which reads as "node is missing" and is thoroughly misleading.
  if (!existsSync(options.cwd)) {
    console.error(`[cinba] cannot start there, the directory is gone: ${options.cwd}`);
    return undefined;
  }

  console.log(`[cinba] starting Pi in ${options.cwd}${options.sessionPath ? " (resuming)" : ""}`);

  const child = startCore({
    cwd: options.cwd,
    provider: model?.provider,
    model: model?.id,
    sessionPath: options.sessionPath,
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => console.error("[pi]", chunk.trimEnd()));

  // Without a listener, a failed spawn raises an unhandled "error" event and
  // takes the whole service down — every other conversation with it. One
  // conversation failing to start must never be able to do that.
  const failed = new Promise<undefined>((resolve) => {
    child.on("error", (error: Error) => {
      console.error(`[cinba] Pi failed to start in ${options.cwd}:`, error.message);
      resolve(undefined);
    });
  });

  const pi = new CoreClient(new StdioTransport(child));

  // Ask Pi who it is. With no session file it has just made a new one, and only
  // it knows the id; with one, this confirms what came back. Racing this against
  // the spawn failure keeps a dead process from leaving the caller hanging
  // forever on a reply that will never come.
  const state = await Promise.race([pi.getState(), failed]);
  if (!state) return undefined;

  const data = state.data as
    | { sessionId?: unknown; model?: { provider?: unknown; id?: unknown } }
    | undefined;
  if (typeof data?.sessionId !== "string") {
    console.error("[cinba] Pi did not report a session id; abandoning this start");
    void pi.close();
    return undefined;
  }

  const session: Live = {
    id: data.sessionId,
    cwd: options.cwd,
    pi,
    ledger: createSession(),
    fold: createEventFolder(),
    model:
      typeof data.model?.provider === "string" && typeof data.model.id === "string"
        ? { provider: data.model.provider, id: data.model.id }
        : undefined,
    pendingConfirms: new Map(),
    outbox: [],
    flushTimer: undefined,
    storedActions: [],
    reconciledUpTo: undefined,
  };

  pi.onEvent((event) => {
    emit(session, session.fold(event));
    // A settled turn is the moment everything of it has been written, and the
    // only moment when nothing is in flight to compare against.
    if (event.type === "agent_settled") void reconcile(session);
  });

  pi.onUiRequest(async (request) => {
    const action = foldUiRequest(request);
    if (!action) return { cancelled: true };

    emit(session, [action]);

    // Hang here until some client sends the user's answer back. This Pi is
    // blocked meanwhile, which is exactly where the permission gate does its
    // work. Other conversations carry on: each has its own process.
    const confirmed = await new Promise<boolean>((resolve) => {
      session.pendingConfirms.set(request.id, resolve);
    });
    return { confirmed };
  });

  // Replay what Pi already stored. This is the whole reason a closed
  // conversation can be reopened without a store of our own.
  await absorb(session);
  for (const action of session.storedActions) session.ledger.apply(action);

  live.set(session.id, session);
  return session;
}

/** Pull whatever Pi has stored since the last pull and fold it onto storedActions. */
async function absorb(session: Live): Promise<void> {
  const response = await session.pi.getEntries(session.reconciledUpTo);
  const entries = (response.data as { entries?: unknown } | undefined)?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return;

  session.storedActions.push(...foldSessionEntries(entries));

  const last = entries.at(-1) as { id?: unknown } | undefined;
  if (typeof last?.id === "string") session.reconciledUpTo = last.id;
}

/**
 * Check the ledger against Pi's file at the end of a turn, and take Pi's word
 * where they disagree.
 *
 * The ledger is built twice by different routes: live, from the event stream,
 * and on reopening, from the stored entries. Only one of them is authoritative.
 * Without this check a misread event would sit in the transcript unnoticed
 * until the conversation was next reopened; with it, any drift lasts one turn.
 *
 * A matching transcript is left alone rather than replaced wholesale, so the
 * ephemeral notices keep their place in it.
 */
async function reconcile(session: Live): Promise<void> {
  await absorb(session);

  const truth = createSession();
  for (const action of session.storedActions) truth.apply(action);

  const current = session.ledger.snapshot();
  if (sameTranscript(current.entries, truth.snapshot().entries)) return;

  console.warn(`[cinba] transcript drifted in ${session.id}; taking Pi's copy`);
  session.ledger = truth;
  toViewers(session.id, snapshotOf(session));
}

function stop(sessionId: string): void {
  const session = live.get(sessionId);
  if (!session) return;
  if (session.flushTimer) clearTimeout(session.flushTimer);
  void session.pi.close();
  live.delete(sessionId);
}

/**
 * The conversation to show a client that has not chosen one: the last one used,
 * else the most recent, else a new one.
 *
 * Callers share one in-flight attempt. Two clients connecting at the same
 * moment would otherwise each start a conversation, and one of them would be a
 * stray empty one.
 */
let resolving: Promise<Live | undefined> | undefined;

function defaultSession(): Promise<Live | undefined> {
  resolving ??= resolveDefaultSession().finally(() => {
    resolving = undefined;
  });
  return resolving;
}

async function resolveDefaultSession(): Promise<Live | undefined> {
  if (lastSessionId) {
    const existing = live.get(lastSessionId);
    if (existing) return existing;
    const stored = await findSession(lastSessionId);
    if (stored) return await open({ sessionPath: stored.path, cwd: stored.cwd || cwd });
  }

  const [recent] = await listSessions(cwd);
  if (recent) {
    const existing = live.get(recent.id);
    if (existing) return existing;
    const stored = await findSession(recent.id);
    if (stored) return await open({ sessionPath: stored.path, cwd: stored.cwd || cwd });
  }

  return await open({ cwd });
}

/** Point a client at a conversation and hand it the full picture. */
function show(socket: WebSocket, session: Live): void {
  viewing.set(socket, session.id);
  lastSessionId = session.id;
  // New conversations start where the last one you looked at lives.
  cwd = session.cwd;
  saveConfig();
  sendTo(socket, { type: "session_opened", sessionId: session.id });
  sendTo(socket, snapshotOf(session));
}

// ---- Messages from clients ----

async function handle(socket: WebSocket, raw: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  const message = parseClientMessage(parsed);
  if (!message) return; // Anything unrecognized is dropped

  const current = live.get(viewing.get(socket) ?? "");

  switch (message.type) {
    case "prompt":
      if (!current) return;
      // Go busy immediately instead of waiting for agent_start to come back from Pi.
      emit(current, [{ type: "busy_changed", busy: true }]);
      void current.pi.prompt(message.text);
      return;

    case "abort":
      if (!current) return;
      void current.pi.abort();
      emit(current, [{ type: "notice", text: "aborted" }]);
      return;

    case "respond_confirm": {
      if (!current) return;
      const resolve = current.pendingConfirms.get(message.requestId);
      if (!resolve) return; // Somebody already answered first
      current.pendingConfirms.delete(message.requestId);

      // The user allowed it, so the card moves to running. This is the only
      // source of the running status: Pi emits nothing between the
      // confirmation and the end of execution.
      if (message.confirmed) {
        const pending = current.ledger
          .snapshot()
          .entries.find(
            (entry) => entry.kind === "tool" && entry.confirmRequestId === message.requestId,
          );
        if (pending && pending.kind === "tool") {
          emit(current, [
            {
              type: "tool_changed",
              toolCallId: pending.toolCallId,
              toolName: pending.toolName,
              status: "running",
            },
          ]);
        }
      }

      resolve(message.confirmed);
      return;
    }

    case "list_dir": {
      // A browser cannot see local paths, deliberately, so the server lists
      // directories and the UI only draws them. Listing directories adds no new
      // capability: this service can already run any command.
      let dirs: string[] = [];
      try {
        dirs = readdirSync(message.path, { withFileTypes: true })
          .filter((item) => item.isDirectory() && !item.name.startsWith("."))
          .map((item) => item.name)
          .sort();
      } catch {
        // Unreadable (missing, no permission) counts as empty; the UI can just show nothing.
      }
      const parent = dirname(message.path);
      sendTo(socket, {
        type: "dir_listing",
        path: message.path,
        parent: parent === message.path ? null : parent,
        dirs,
      });
      return;
    }

    case "list_models": {
      if (!current) return;
      // Pi returns only the models this machine has credentials for, which is
      // exactly the list worth showing. Everything but provider and id is
      // dropped: the picker needs no more than that.
      const response = await current.pi.getAvailableModels();
      const raw2 = (response.data as { models?: unknown } | undefined)?.models;
      const models: ModelRef[] = (Array.isArray(raw2) ? raw2 : []).flatMap((item) => {
        const candidate = item as { provider?: unknown; id?: unknown };
        return typeof candidate.provider === "string" && typeof candidate.id === "string"
          ? [{ provider: candidate.provider, id: candidate.id }]
          : [];
      });
      sendTo(socket, { type: "model_listing", models });
      return;
    }

    case "set_model": {
      if (!current) return;
      // No restart and no clearing of the transcript: Pi switches models on the
      // running process, so the conversation carries on with its context. That
      // is the point — a weak answer can be handed straight to a better model.
      const target: ModelRef = { provider: message.provider, id: message.modelId };
      const response = await current.pi.setModel(target.provider, target.id);
      if (!response.success) {
        emit(current, [{ type: "notice", text: `model not switched: ${String(response.error)}` }]);
        return;
      }
      current.model = target;
      // Remembered as the default for conversations started from now on.
      model = target;
      saveConfig();
      // Pi writes a model_change entry of its own, so this marker is a
      // projection of that rather than a fact only we hold.
      emit(current, [
        { type: "model_in_use", provider: target.provider, modelId: target.id },
      ]);
      toViewers(current.id, { type: "model_changed", model: target });
      return;
    }

    case "list_sessions":
      sendTo(socket, { type: "session_listing", sessions: await listSessions(message.cwd) });
      return;

    case "open_session": {
      const already = live.get(message.sessionId);
      if (already) {
        show(socket, already);
        return;
      }
      const stored = await findSession(message.sessionId);
      if (!stored) return; // Deleted from under us; the client's next listing will show that
      // Its own directory, not whichever one is current: a conversation about
      // one project must not resume with its tools pointed at another.
      const opened = await open({ sessionPath: stored.path, cwd: stored.cwd || cwd });
      if (opened) show(socket, opened);
      return;
    }

    case "create_session": {
      cwd = message.cwd;
      const created = await open({ cwd: message.cwd });
      if (created) show(socket, created);
      return;
    }

    case "delete_session": {
      const path = (await findSession(message.sessionId))?.path;
      stop(message.sessionId);
      if (path) {
        try {
          rmSync(path);
        } catch {
          // Already gone, or not ours to remove. The listing below tells the truth either way.
        }
      }
      if (lastSessionId === message.sessionId) {
        lastSessionId = undefined;
        saveConfig();
      }

      // Anyone who was looking at it needs somewhere to go.
      const orphaned = [...viewing].filter(([, id]) => id === message.sessionId);
      const fallback = orphaned.length > 0 ? await defaultSession() : undefined;
      for (const [orphan] of orphaned) {
        if (fallback) show(orphan, fallback);
      }

      sendTo(socket, { type: "session_listing", sessions: await listSessions() });
      return;
    }
  }
}

// ---- Starting the service ----

loadConfig();

// The WebSocket and the static files share one port: the UI loads from here and connects back here.
const httpServer = createServer((request, response) => void serveStatic(request, response));
// The WebSocket gets its own path and static files take the rest, so in
// development Vite only has to proxy /ws here while still serving the page
// itself, which keeps hot reload.
const server = new WebSocketServer({ server: httpServer, path: "/ws" });

httpServer.listen(PORT, HOST, () => {
  console.log(`[cinba] UI at http://${HOST}:${PORT}`);
  console.log(`[cinba] working directory ${cwd}`);
  if (model) console.log(`[cinba] model ${model.provider}/${model.id}`);
});

server.on("connection", (socket: WebSocket) => {
  clients.add(socket);
  console.log(`[cinba] client connected, ${clients.size} now`);

  // A new connection lands on the conversation it was last on. Its Pi starts
  // here if it was not already running, which is why nothing starts at boot.
  void defaultSession().then((session) => {
    if (session) show(socket, session);
  });

  socket.on("message", (data: unknown) => void handle(socket, String(data)));
  socket.on("close", () => {
    clients.delete(socket);
    viewing.delete(socket);
    console.log(`[cinba] client disconnected, ${clients.size} left`);
  });
});

function shutdown(): void {
  console.log(`\n[cinba] shutting down, reclaiming ${live.size} Pi child process(es)`);
  for (const id of [...live.keys()]) stop(id);
  server.close();
  httpServer.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
