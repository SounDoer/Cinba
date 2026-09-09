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
// Usage: node <repo>/packages/server/src/index.ts

import type { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearCredential,
  findSession,
  listProviders,
  listSessions as storedSessions,
  setApiKey,
  startPi,
} from "@cinba/agent";
import { isLoopback } from "./loopback.ts";
import { assessIdle, canStopNow, IDLE_TIMEOUT_MS } from "./reclaim.ts";
import { createConfigStore } from "./config.ts";
import { createServerRuntime } from "./server-runtime.ts";
import { createStaticFileHandler } from "./static-files.ts";
import {
  createEventFolder,
  foldSessionEntries,
  foldUiRequest,
  PiClient,
  StdioTransport,
} from "@cinba/agent";
import { createSession, parseClientMessage, sameTranscript } from "@cinba/contract";
import type {
  ModelRef,
  ServerMessage,
  Session,
  SessionSummary,
  ViewAction,
} from "@cinba/contract";

const HOST = "127.0.0.1";

/**
 * Configurable so a second core can run on this machine.
 *
 * The real arrangement is one core per machine, all on the default port. This
 * exists so the two-core case can be built and tested on one desk rather than
 * only after a second machine is set up.
 */
const PORT = Number(process.env.CINBA_PORT) || 4517;

/** Text deltas arrive token by token; batch them so each character is not its own round trip. */
const FLUSH_INTERVAL_MS = 30;

/** Where the built UI lives. Located relative to the repo layout, not through package resolution. */
const WEB_DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
const serveStatic = createStaticFileHandler(WEB_DIST);
const config = createConfigStore(join(homedir(), ".cinba", "config.json"), {
  cwd: homedir(),
  coreName: hostname(),
});

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
  pi: PiClient;
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
  /** When nobody was last looking at it; undefined while someone is. See reclaim.ts. */
  idleSince: number | undefined;
  /** Its Pi started before the current credentials. See recycleStale(). */
  staleCredentials: boolean;
};

const live = new Map<string, Live>();

/** Which conversation each client is looking at. Two clients may differ. */
const viewing = new Map<WebSocket, string>();

const clients = new Set<WebSocket>();

/**
 * Which clients arrived over the loopback address.
 *
 * Credential changes are refused from anywhere else. Today every connection is
 * loopback and this rejects nothing — but the whole point is that it is already
 * in place before that stops being true. Reading a conversation and changing
 * which API key the machine uses are not the same kind of act, and the second
 * should not become reachable the moment a door opens outward.
 */
const local = new WeakSet<WebSocket>();



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
async function open(options: {
  sessionPath?: string;
  cwd: string;
  /**
   * Which model this Pi starts on, when it should not be the service default.
   * Replacing a conversation's process must not quietly move it to another
   * model, so recycling passes the one it was already using.
   */
  model?: ModelRef;
}): Promise<Live | undefined> {
  // A directory that has since been renamed or removed makes spawn fail with
  // ENOENT, which reads as "node is missing" and is thoroughly misleading.
  if (!existsSync(options.cwd)) {
    console.error(`[cinba] cannot start there, the directory is gone: ${options.cwd}`);
    return undefined;
  }

  console.log(`[cinba] starting Pi in ${options.cwd}${options.sessionPath ? " (resuming)" : ""}`);

  const starting = options.model ?? config.get().model;
  const child = startPi({
    cwd: options.cwd,
    provider: starting?.provider,
    model: starting?.id,
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

  const pi = new PiClient(new StdioTransport(child));

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
    idleSince: undefined,
    staleCredentials: false,
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
  const { cwd, lastSessionId } = config.get();
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
  config.update({
    lastSessionId: session.id,
    // New conversations start where the last one you looked at lives.
    cwd: session.cwd,
  });
  sendTo(socket, { type: "session_opened", sessionId: session.id });
  sendTo(socket, snapshotOf(session));
}

// ---- Reclaiming idle conversations ----

/**
 * Stop the Pi of any conversation nobody has watched for a while.
 *
 * Safe because the conversation is not in the process: Pi wrote it to its
 * session file, so opening it again brings the context back. What this buys is
 * memory — a process costs 60-85MB whether or not anyone is looking, and
 * several people each leaving a few conversations open adds up.
 */
function sweepIdle(): void {
  const now = Date.now();

  for (const session of [...live.values()] ) {
    const hasViewers = [...viewing.values()].includes(session.id);
    const verdict = assessIdle(
      {
        hasViewers,
        busy: session.ledger.snapshot().busy,
        awaitingConfirmation: session.pendingConfirms.size > 0,
        idleSince: session.idleSince,
      },
      now,
    );

    session.idleSince = verdict.idleSince;
    if (!verdict.reclaim) continue;

    console.log(`[cinba] ${session.id} idle, stopping its Pi (it reopens from disk)`);
    stop(session.id);
  }
}

// ---- Handing conversations the current credentials ----

/**
 * Note that every open conversation is talking to a Pi that started before the
 * credentials changed, and replace those processes as soon as it is safe.
 *
 * A Pi reads the credential file once, at startup. A provider added afterwards
 * is invisible to it: its model list comes back without those models, and
 * switching to one fails with "Model not found" — which is why adding a key
 * appeared to do nothing until the conversation happened to be reopened. Pi's
 * RPC has no command that makes it look again, so the only way to give it a new
 * key is to give it a new process.
 */
function markCredentialsStale(): void {
  for (const session of live.values()) session.staleCredentials = true;
  void recycleStale();
}

/**
 * Replace the Pi of every conversation whose credentials are stale.
 *
 * Safe for the same reason reclaiming is: the conversation is in Pi's session
 * file, not in the process. The one thing that must not happen is cutting into
 * a turn, so a conversation that is busy or waiting on an allow/deny keeps its
 * process and the next sweep tries again.
 *
 * A conversation nobody is watching is only stopped — it comes back from disk
 * when someone asks for it, and starting a process now would waste exactly what
 * reclaim.ts exists to save. One that is being watched is reopened straight
 * away instead, because its viewers would otherwise be pointed at a
 * conversation that is no longer open, and their next message would go nowhere.
 */
async function recycleStale(): Promise<void> {
  if (![...live.values()].some((session) => session.staleCredentials)) return;

  // Which providers this machine can reach now. A conversation is put back on
  // the model it was using only if that is still one of them: Pi will not start
  // on a provider it has no credential for, and that includes the placeholder
  // it reports when it has none at all. Getting this wrong leaves a
  // conversation with no process rather than with the wrong model.
  const reachable = new Set(
    (await listProviders()).filter((provider) => provider.configured).map((provider) => provider.id),
  );

  for (const session of [...live.values()]) {
    if (!session.staleCredentials) continue;
    if (
      !canStopNow({
        busy: session.ledger.snapshot().busy,
        awaitingConfirmation: session.pendingConfirms.size > 0,
      })
    ) {
      continue;
    }

    const watchers = [...viewing.entries()]
      .filter(([, id]) => id === session.id)
      .map(([socket]) => socket);
    const wasUsing =
      session.model && reachable.has(session.model.provider) ? session.model : undefined;

    // Found before the process goes, so what replaces it is already known.
    const stored = watchers.length > 0 ? await findSession(session.id) : undefined;

    console.log(`[cinba] ${session.id} has stale credentials, restarting its Pi`);
    stop(session.id);
    if (watchers.length === 0) continue;

    const reopened = stored
      ? await open({ sessionPath: stored.path, cwd: stored.cwd || session.cwd, model: wasUsing })
      : // Pi writes the session file with the first entry, so a conversation
        // with nothing in it yet has none to come back from. A new one in the
        // same directory is the same empty conversation.
        await open({ cwd: session.cwd, model: wasUsing });
    if (!reopened) {
      // Its directory has gone, or Pi would not start there. Nothing to show,
      // and nothing to be gained by pretending otherwise: the client picks
      // another conversation from its next listing.
      console.error(`[cinba] could not reopen ${session.id} after a credential change`);
      continue;
    }
    for (const socket of watchers) show(socket, reopened);
  }
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
      config.update({ model: target });
      // Pi writes a model_change entry of its own, so this marker is a
      // projection of that rather than a fact only we hold.
      emit(current, [
        { type: "model_in_use", provider: target.provider, modelId: target.id },
      ]);
      toViewers(current.id, { type: "model_changed", model: target });
      return;
    }

    case "list_providers":
      // Status only: which providers are usable. Never how.
      sendTo(socket, { type: "provider_listing", providers: await listProviders() });
      return;

    case "set_api_key": {
      if (!local.has(socket)) {
        // Deliberately says nothing about why beyond this: a remote caller
        // learns only that it cannot.
        console.warn("[cinba] refused a credential change from a non-local client");
        if (current) {
          emit(current, [{ type: "notice", text: "credentials can only be changed locally" }]);
        }
        return;
      }
      try {
        await setApiKey(message.providerId, message.apiKey);
        // The provider's name, never the key, and never the fact that it has one logged.
        if (current) {
          emit(current, [{ type: "notice", text: `${message.providerId} is configured` }]);
        }
        markCredentialsStale();
      } catch (error) {
        // The message from a failed login can be shown; it never contains the key.
        const reason = error instanceof Error ? error.message : String(error);
        if (current) emit(current, [{ type: "notice", text: `could not configure: ${reason}` }]);
      }
      sendTo(socket, { type: "provider_listing", providers: await listProviders() });
      return;
    }

    case "clear_credential": {
      if (!local.has(socket)) {
        console.warn("[cinba] refused a credential change from a non-local client");
        return;
      }
      await clearCredential(message.providerId);
      if (current) {
        emit(current, [{ type: "notice", text: `${message.providerId} is no longer configured` }]);
      }
      // A removed key matters as much as an added one: a Pi that still holds it
      // would go on offering models this machine can no longer reach.
      markCredentialsStale();
      sendTo(socket, { type: "provider_listing", providers: await listProviders() });
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
      const opened = await open({ sessionPath: stored.path, cwd: stored.cwd || config.get().cwd });
      if (opened) show(socket, opened);
      return;
    }

    case "create_session": {
      const created = await open({ cwd: message.cwd });
      if (created) show(socket, created);
      return;
    }

    case "rename_session": {
      if (!current) return;
      // Through the conversation's own Pi rather than by writing its file from
      // out here: Pi holds that session open and would not see an outside
      // append, so the two would disagree about what it is called.
      const response = await current.pi.setSessionName(message.name);
      if (!response.success) {
        emit(current, [{ type: "notice", text: `not renamed: ${String(response.error)}` }]);
        return;
      }
      emit(current, [{ type: "notice", text: `named "${message.name}"` }]);
      // The name lives in the session file, so a fresh listing picks it up.
      sendTo(socket, { type: "session_listing", sessions: await listSessions() });
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
      if (config.get().lastSessionId === message.sessionId) {
        config.update({ lastSessionId: undefined });
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

function onConnection(socket: WebSocket, request: IncomingMessage): void {
  clients.add(socket);
  if (isLoopback(request.socket.remoteAddress)) local.add(socket);

  // Before anything else: which machine the client has reached.
  sendTo(socket, { type: "core_identity", name: config.get().coreName });
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
}

// HTTP, WebSocket, and maintenance share one lifecycle owner. The WebSocket
// gets /ws while static files take the other paths, so Vite only proxies /ws.
const runtime = createServerRuntime({
  host: HOST,
  port: PORT,
  serveHttp: serveStatic,
  onConnection,
  maintain: () => {
    // Checked every minute rather than on a timer per conversation: a minute
    // of imprecision on a ten-minute idle rule changes nothing.
    sweepIdle();
    // Retry conversations that were mid-turn when credentials changed.
    void recycleStale();
  },
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[cinba] shutting down, reclaiming ${live.size} Pi child process(es)`);
  for (const id of [...live.keys()]) stop(id);
  void runtime.stop().finally(() => process.exit(0));
}

function startService(): void {
  void runtime
    .start()
    .then((address) => {
      const currentConfig = config.get();
      console.log(
        `[cinba] core "${currentConfig.coreName}" - UI at http://${address.host}:${address.port}`,
      );
      console.log(`[cinba] working directory ${currentConfig.cwd}`);
      console.log(
        `[cinba] idle conversations release their process after ${IDLE_TIMEOUT_MS / 60_000} minutes`,
      );
      if (currentConfig.model) {
        console.log(`[cinba] model ${currentConfig.model.provider}/${currentConfig.model.id}`);
      }
    })
    .catch((error: unknown) => {
      console.error("[cinba] service failed to start:", error);
      process.exitCode = 1;
    });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Importing the module is inert; only executing it as the program opens ports.
if (import.meta.main) startService();
