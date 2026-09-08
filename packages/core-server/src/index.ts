// Cinba's local core service.
//
// Pi lives here and so does the session ledger, which makes this the single
// source of truth. The GUI and (from 3b on) the web UI are both its clients.
//
// It listens on 127.0.0.1 only. That is the sole reason this phase has no
// network attack surface, and it must never become 0.0.0.0: this service can
// run any command on this machine, so opening a door outward is a different
// order of problem and belongs to 3b.
//
// Usage: node <repo>/packages/core-server/src/index.ts

import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { startCore } from "@cinba/core-host";
import {
  CoreClient,
  createEventFolder,
  createSession,
  foldUiRequest,
  parseClientMessage,
  StdioTransport,
} from "@cinba/core-client";
import type { ServerMessage, Session, ViewAction } from "@cinba/core-client";

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
  // in place before 3b-2 opens a channel outward.
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

const clients = new Set<WebSocket>();

let client: CoreClient | undefined;
let session: Session = createSession();
let cwd = homedir();

/** Outstanding permission confirmations: requestId to the function that hands the answer back to CoreClient. */
const pendingConfirms = new Map<string, (confirmed: boolean) => void>();

let outbox: ViewAction[] = [];
let flushTimer: NodeJS.Timeout | undefined;

// ---- Remembering the working directory ----

const configDir = join(homedir(), ".cinba");

function configPath(): string {
  return join(configDir, "config.json");
}

function loadCwd(): string {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as { cwd?: unknown };
    if (typeof parsed.cwd === "string" && existsSync(parsed.cwd)) return parsed.cwd;
  } catch {
    // On first start the file does not exist, which is normal.
  }
  return homedir();
}

function saveCwd(next: string): void {
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ cwd: next }, null, 2), "utf8");
  } catch {
    // Failing to remember does not affect this run, and is not worth interrupting the service for.
  }
}

// ---- Broadcasting ----

function sendTo(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}

function broadcast(message: ServerMessage): void {
  const text = JSON.stringify(message);
  for (const socket of clients) socket.send(text);
}

/** Record into the ledger and queue for broadcast. */
function emit(actions: ViewAction[]): void {
  for (const action of actions) session.apply(action);
  outbox.push(...actions);

  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    const batch = outbox;
    outbox = [];
    if (batch.length > 0) broadcast({ type: "actions", actions: batch });
  }, FLUSH_INTERVAL_MS);
}

// ---- Pi ----

/** Start a fresh Pi process and clear the ledger. Switching working directory comes through here too. */
function startSession(): void {
  void client?.close();
  pendingConfirms.clear();
  outbox = [];
  session = createSession();

  const fold = createEventFolder();
  const child = startCore({ cwd });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => console.error("[pi]", chunk.trimEnd()));

  const next = new CoreClient(new StdioTransport(child));

  next.onEvent((event) => emit(fold(event)));

  next.onUiRequest(async (request) => {
    const action = foldUiRequest(request);
    if (!action) return { cancelled: true };

    emit([action]);

    // Hang here until some client sends the user's answer back. The core is
    // blocked meanwhile, which is exactly where the permission gate does its work.
    const confirmed = await new Promise<boolean>((resolve) => {
      pendingConfirms.set(request.id, resolve);
    });
    return { confirmed };
  });

  client = next;
}

// ---- Messages from clients ----

function handle(raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  const message = parseClientMessage(parsed);
  if (!message) return; // Anything unrecognized is dropped

  switch (message.type) {
    case "prompt":
      // Go busy immediately instead of waiting for agent_start to come back from Pi.
      emit([{ type: "busy_changed", busy: true }]);
      void client?.prompt(message.text);
      return;

    case "abort":
      void client?.abort();
      emit([{ type: "notice", text: "aborted" }]);
      return;

    case "respond_confirm": {
      const resolve = pendingConfirms.get(message.requestId);
      if (!resolve) return; // Somebody already answered first
      pendingConfirms.delete(message.requestId);

      // The user allowed it, so the card moves to running. This is the only
      // source of the running status: Pi emits nothing between the
      // confirmation and the end of execution.
      if (message.confirmed) {
        const pending = session
          .snapshot()
          .entries.find(
            (entry) => entry.kind === "tool" && entry.confirmRequestId === message.requestId,
          );
        if (pending && pending.kind === "tool") {
          emit([
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

    case "set_project":
      cwd = message.cwd;
      saveCwd(cwd);
      startSession();
      // Snapshot first, then reset: by the time a client sees reset, the snapshot it holds must already be the new one.
      broadcast({ type: "snapshot", snapshot: session.snapshot(), cwd });
      broadcast({ type: "reset", cwd });
      return;

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
      broadcast({
        type: "dir_listing",
        path: message.path,
        parent: parent === message.path ? null : parent,
        dirs,
      });
      return;
    }
  }
}

// ---- Starting the service ----

cwd = loadCwd();
startSession();

// The WebSocket and the static files share one port: the UI loads from here and connects back here.
const httpServer = createServer((request, response) => void serveStatic(request, response));
// The WebSocket gets its own path and static files take the rest, so in
// development Vite only has to proxy /ws here while still serving the page
// itself, which keeps hot reload.
const server = new WebSocketServer({ server: httpServer, path: "/ws" });

httpServer.listen(PORT, HOST, () => {
  console.log(`[cinba] UI at http://${HOST}:${PORT}`);
  console.log(`[cinba] working directory ${cwd}`);
});

server.on("connection", (socket: WebSocket) => {
  clients.add(socket);
  console.log(`[cinba] client connected, ${clients.size} now`);

  // A new connection gets a full snapshot first. That is how a client joining
  // midway catches up on what it missed: events already streamed cannot be
  // recovered, which is precisely why the ledger has to live on the server.
  sendTo(socket, { type: "snapshot", snapshot: session.snapshot(), cwd });

  socket.on("message", (data: unknown) => handle(String(data)));
  socket.on("close", () => {
    clients.delete(socket);
    console.log(`[cinba] client disconnected, ${clients.size} left`);
  });
});

function shutdown(): void {
  console.log("\n[cinba] shutting down, reclaiming the Pi child process");
  void client?.close();
  server.close();
  httpServer.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
