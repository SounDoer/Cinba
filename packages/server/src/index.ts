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
import { rmSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findSession } from "@cinba/agent";
import { isLoopback } from "./loopback.ts";
import { assessIdle, canStopNow, IDLE_TIMEOUT_MS } from "./reclaim.ts";
import { createConfigStore } from "./config.ts";
import { createCredentialService } from "./credential-service.ts";
import { listDirectories } from "./directory-browser.ts";
import { createServerRuntime } from "./server-runtime.ts";
import { createSessionRegistry } from "./session-registry.ts";
import type { LiveSession } from "./session-registry.ts";
import { createStaticFileHandler } from "./static-files.ts";
import { parseClientMessage } from "@cinba/contract";
import type { ModelRef, ServerMessage } from "@cinba/contract";

const HOST = "127.0.0.1";

/**
 * Configurable so a second core can run on this machine.
 *
 * The real arrangement is one core per machine, all on the default port. This
 * exists so the two-core case can be built and tested on one desk rather than
 * only after a second machine is set up.
 */
const PORT = Number(process.env.CINBA_PORT) || 4517;

/** Where the built UI lives. Located relative to the repo layout, not through package resolution. */
const WEB_DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
const serveStatic = createStaticFileHandler(WEB_DIST);
const config = createConfigStore(join(homedir(), ".cinba", "config.json"), {
  cwd: homedir(),
  coreName: hostname(),
});

// ---- State ----

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

const sessions = createSessionRegistry({
  defaultModel: () => config.get().model,
  hasViewers: (sessionId) => [...viewing.values()].includes(sessionId),
  onActions: (sessionId, actions) => {
    toViewers(sessionId, { type: "actions", actions });
  },
  onSnapshot: toViewers,
});

const credentials = createCredentialService({ onChanged: markCredentialsStale });

/**
 * The conversation to show a client that has not chosen one: the last one used,
 * else the most recent, else a new one.
 *
 * Callers share one in-flight attempt. Two clients connecting at the same
 * moment would otherwise each start a conversation, and one of them would be a
 * stray empty one.
 */
let resolving: Promise<LiveSession | undefined> | undefined;

function defaultSession(): Promise<LiveSession | undefined> {
  resolving ??= resolveDefaultSession().finally(() => {
    resolving = undefined;
  });
  return resolving;
}

async function resolveDefaultSession(): Promise<LiveSession | undefined> {
  const { cwd, lastSessionId } = config.get();
  if (lastSessionId) {
    const existing = sessions.get(lastSessionId);
    if (existing) return existing;
    const stored = await findSession(lastSessionId);
    if (stored) return await sessions.open({ sessionPath: stored.path, cwd: stored.cwd || cwd });
  }

  const [recent] = await sessions.list(cwd);
  if (recent) {
    const existing = sessions.get(recent.id);
    if (existing) return existing;
    const stored = await findSession(recent.id);
    if (stored) return await sessions.open({ sessionPath: stored.path, cwd: stored.cwd || cwd });
  }

  return await sessions.open({ cwd });
}

/** Point a client at a conversation and hand it the full picture. */
function show(socket: WebSocket, session: LiveSession): void {
  const previousSessionId = viewing.get(socket);
  viewing.set(socket, session.id);
  if (
    previousSessionId &&
    previousSessionId !== session.id &&
    ![...viewing.values()].includes(previousSessionId)
  ) {
    const previous = sessions.get(previousSessionId);
    if (previous) sessions.denyPendingConfirmations(previous);
  }
  config.update({
    lastSessionId: session.id,
    // New conversations start where the last one you looked at lives.
    cwd: session.cwd,
  });
  sendTo(socket, { type: "session_opened", sessionId: session.id });
  sendTo(socket, sessions.snapshot(session));
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

  for (const session of sessions.values()) {
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
    sessions.stop(session.id);
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
  for (const session of sessions.values()) session.staleCredentials = true;
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
  if (!sessions.values().some((session) => session.staleCredentials)) return;

  // Which providers this machine can reach now. A conversation is put back on
  // the model it was using only if that is still one of them: Pi will not start
  // on a provider it has no credential for, and that includes the placeholder
  // it reports when it has none at all. Getting this wrong leaves a
  // conversation with no process rather than with the wrong model.
  const reachable = new Set(
    (await credentials.list())
      .filter((provider) => provider.configured)
      .map((provider) => provider.id),
  );

  for (const session of sessions.values()) {
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
    sessions.stop(session.id);
    if (watchers.length === 0) continue;

    const reopened = stored
      ? await sessions.open({
          sessionPath: stored.path,
          cwd: stored.cwd || session.cwd,
          model: wasUsing,
        })
      : // Pi writes the session file with the first entry, so a conversation
        // with nothing in it yet has none to come back from. A new one in the
        // same directory is the same empty conversation.
        await sessions.open({ cwd: session.cwd, model: wasUsing });
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

  const current = sessions.get(viewing.get(socket) ?? "");

  switch (message.type) {
    case "prompt":
      if (!current) return;
      sessions.prompt(current, message.text);
      return;

    case "edit_message":
      if (!current) return;
      await sessions.editMessage(current, message.entryId, message.text);
      return;

    case "abort":
      if (!current) return;
      sessions.abort(current);
      return;

    case "respond_confirm":
      if (!current) return;
      sessions.respondToConfirmation(current, message.requestId, message.confirmed);
      return;

    case "list_dir": {
      sendTo(socket, listDirectories(message.path));
      return;
    }

    case "list_models": {
      if (!current) return;
      sendTo(socket, { type: "model_listing", models: await sessions.listModels(current) });
      return;
    }

    case "set_model": {
      if (!current) return;
      const target: ModelRef = { provider: message.provider, id: message.modelId };
      if (!(await sessions.setModel(current, target))) return;
      // Remembered as the default for conversations started from now on.
      config.update({ model: target });
      toViewers(current.id, { type: "model_changed", model: target });
      return;
    }

    case "list_providers":
      // Status only: which providers are usable. Never how.
      sendTo(socket, { type: "provider_listing", providers: await credentials.list() });
      return;

    case "set_api_key": {
      if (!local.has(socket)) {
        // Deliberately says nothing about why beyond this: a remote caller
        // learns only that it cannot.
        console.warn("[cinba] refused a credential change from a non-local client");
        if (current) {
          sessions.emit(current, [
            { type: "notice", text: "credentials can only be changed locally" },
          ]);
        }
        return;
      }
      const result = await credentials.configure(message.providerId, message.apiKey);
      if (current) sessions.emit(current, [{ type: "notice", text: result.notice }]);
      sendTo(socket, { type: "provider_listing", providers: await credentials.list() });
      return;
    }

    case "clear_credential": {
      if (!local.has(socket)) {
        console.warn("[cinba] refused a credential change from a non-local client");
        return;
      }
      const result = await credentials.remove(message.providerId);
      if (current) sessions.emit(current, [{ type: "notice", text: result.notice }]);
      sendTo(socket, { type: "provider_listing", providers: await credentials.list() });
      return;
    }

    case "list_sessions":
      sendTo(socket, { type: "session_listing", sessions: await sessions.list(message.cwd) });
      return;

    case "open_session": {
      const already = sessions.get(message.sessionId);
      if (already) {
        show(socket, already);
        return;
      }
      const stored = await findSession(message.sessionId);
      if (!stored) return; // Deleted from under us; the client's next listing will show that
      // Its own directory, not whichever one is current: a conversation about
      // one project must not resume with its tools pointed at another.
      const opened = await sessions.open({
        sessionPath: stored.path,
        cwd: stored.cwd || config.get().cwd,
      });
      if (opened) show(socket, opened);
      return;
    }

    case "create_session": {
      const created = await sessions.open({ cwd: message.cwd });
      if (created) show(socket, created);
      return;
    }

    case "rename_session": {
      if (!current) return;
      if (!(await sessions.rename(current, message.name))) return;
      // The name lives in the session file, so a fresh listing picks it up.
      sendTo(socket, { type: "session_listing", sessions: await sessions.list() });
      return;
    }

    case "delete_session": {
      const path = (await findSession(message.sessionId))?.path;
      sessions.stop(message.sessionId);
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

      sendTo(socket, { type: "session_listing", sessions: await sessions.list() });
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

  socket.on("message", (data: unknown) => {
    void handle(socket, String(data)).catch((error: unknown) => {
      console.error(
        "[cinba] client message failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
  });
  socket.on("close", () => {
    clients.delete(socket);
    const previousSessionId = viewing.get(socket);
    viewing.delete(socket);
    if (previousSessionId && ![...viewing.values()].includes(previousSessionId)) {
      const previous = sessions.get(previousSessionId);
      if (previous) sessions.denyPendingConfirmations(previous);
    }
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
  console.log(`\n[cinba] shutting down, reclaiming ${sessions.size} Pi child process(es)`);
  sessions.closeAll();
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
