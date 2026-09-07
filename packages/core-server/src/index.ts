// Cinba 本机核心服务。
//
// Pi 住在这里，会话账本也在这里——它是唯一真相。GUI 与（3b 之后的）网页都是它的客户端。
//
// 只监听 127.0.0.1。这是本阶段没有网络安全面的唯一依据，任何时候都不得改成 0.0.0.0——
// 这个服务能在本机执行任意命令，对外开口是另一个量级的问题，属于 3b 的内容。
//
// 用法：node <仓库路径>/packages/core-server/src/index.ts

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

/** 文字增量逐 token 到达，攒一批再发，避免每个字一次网络往返。 */
const FLUSH_INTERVAL_MS = 30;

/** 界面构建产物的所在目录。按仓库布局相对定位，不经过包解析。 */
const WEB_DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/** 提供界面的静态文件。 */
async function serveStatic(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;

  // 防目录穿越：拼完再检查是否仍在 WEB_DIST 之下。
  // 现在只监听回环地址，但这道检查该在 3b-2 开对外通道之前就位。
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
      .end("界面还没构建。请先跑：npm run build --workspace @cinba/web");
  }
}

const clients = new Set<WebSocket>();

let client: CoreClient | undefined;
let session: Session = createSession();
let cwd = homedir();

/** 待回应的权限确认：requestId → 把答案交回给 CoreClient 的那个函数。 */
const pendingConfirms = new Map<string, (confirmed: boolean) => void>();

let outbox: ViewAction[] = [];
let flushTimer: NodeJS.Timeout | undefined;

// ---- 工作目录的记忆 ----

const configDir = join(homedir(), ".cinba");

function configPath(): string {
  return join(configDir, "config.json");
}

function loadCwd(): string {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as { cwd?: unknown };
    if (typeof parsed.cwd === "string" && existsSync(parsed.cwd)) return parsed.cwd;
  } catch {
    // 首次启动没有这个文件，属正常情况。
  }
  return homedir();
}

function saveCwd(next: string): void {
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ cwd: next }, null, 2), "utf8");
  } catch {
    // 记不住不影响这一次使用，不值得中断服务。
  }
}

// ---- 广播 ----

function sendTo(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}

function broadcast(message: ServerMessage): void {
  const text = JSON.stringify(message);
  for (const socket of clients) socket.send(text);
}

/** 记进账本，并排队广播。 */
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

/** 起一个新的 Pi 进程，并把账本清空。切换工作目录时也走这里。 */
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

    // 一直挂着，直到某个客户端把用户的选择送回来。
    // 核心此刻正阻塞等待，这正是权限门起作用的地方。
    const confirmed = await new Promise<boolean>((resolve) => {
      pendingConfirms.set(request.id, resolve);
    });
    return { confirmed };
  });

  client = next;
}

// ---- 客户端来的消息 ----

function handle(raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  const message = parseClientMessage(parsed);
  if (!message) return; // 不认识的一律丢掉

  switch (message.type) {
    case "prompt":
      // 立刻置忙，不等 agent_start 从 Pi 那头回来。
      emit([{ type: "busy_changed", busy: true }]);
      void client?.prompt(message.text);
      return;

    case "abort":
      void client?.abort();
      emit([{ type: "notice", text: "已中止" }]);
      return;

    case "respond_confirm": {
      const resolve = pendingConfirms.get(message.requestId);
      if (!resolve) return; // 已经有人先答过了
      pendingConfirms.delete(message.requestId);

      // 用户点了允许：卡片进入「执行中」。这是 running 状态的唯一来源——
      // Pi 在确认与执行完成之间不发任何事件。
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
      // 先发新快照再发 reset：客户端收到 reset 时手里的快照必须已经是新的。
      broadcast({ type: "snapshot", snapshot: session.snapshot(), cwd });
      broadcast({ type: "reset", cwd });
      return;

    case "list_dir": {
      // 浏览器拿不到本地路径（刻意的安全限制），所以由服务器列目录、界面只负责画。
      // 「能列目录」没有增加新能力——这个服务本来就能执行任意命令。
      let dirs: string[] = [];
      try {
        dirs = readdirSync(message.path, { withFileTypes: true })
          .filter((item) => item.isDirectory() && !item.name.startsWith("."))
          .map((item) => item.name)
          .sort();
      } catch {
        // 读不了（不存在、没权限）就当空目录，界面显示为空即可。
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

// ---- 起服务 ----

cwd = loadCwd();
startSession();

// WebSocket 与静态文件共用一个端口：界面从这里加载，也从这里连回来。
const httpServer = createServer((request, response) => void serveStatic(request, response));
const server = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, HOST, () => {
  console.log(`[cinba] 界面 http://${HOST}:${PORT}`);
  console.log(`[cinba] 工作目录 ${cwd}`);
});

server.on("connection", (socket: WebSocket) => {
  clients.add(socket);
  console.log(`[cinba] 客户端接入，当前 ${clients.size} 个`);

  // 新连接先拿一份完整快照。中途连进来的客户端靠这个补上错过的内容——
  // 已经流过去的事件是追不回来的，这就是账本必须在服务器侧的原因。
  sendTo(socket, { type: "snapshot", snapshot: session.snapshot(), cwd });

  socket.on("message", (data: unknown) => handle(String(data)));
  socket.on("close", () => {
    clients.delete(socket);
    console.log(`[cinba] 客户端断开，当前 ${clients.size} 个`);
  });
});

function shutdown(): void {
  console.log("\n[cinba] 正在关闭，回收 Pi 子进程");
  void client?.close();
  server.close();
  httpServer.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
