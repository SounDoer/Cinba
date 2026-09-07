# 阶段 3a：本机拆分 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Pi 从 Electron 主进程搬进独立的本机服务进程，GUI 改为通过 WebSocket 连接它，用起来和现在一模一样。

**Architecture:** 新增 `core-server`：持有 Pi 子进程、`CoreClient`、以及作为唯一真相的 `session` 账本，通过 `ws` 在 `127.0.0.1:4517` 提供服务。客户端侧新增 `RemoteSession`（用原生 WebSocket，零依赖），与 `CoreClient` 并列而非叠加。Electron 主进程退化为「WebSocket ↔ IPC 中继」，**渲染层一行不改**。

**Tech Stack:** `ws`（仅服务端）、原生 WebSocket（客户端）、Node 24 类型剥离、`node --test`。

设计依据：`docs/specs/2026-09-07-phase3-remote-design.md`

---

## 进度

| Task | 状态 |
|---|---|
| 1. 协议与 RemoteSession | ✅ 完成，7 个测试通过 |
| 2. 账本可从快照重建 | ✅ 完成，2 个测试通过（合计 45）|
| 3. core-server | 未开始 |
| 4. GUI 改成客户端 | 未开始 |
| 5. 多客户端与生命周期验收 | 未开始 |

---

## 动手前查实的事实

- **`ws` 8.21.3 没有安装脚本**（只有 lint/test/integration），不需要 `npm approve-scripts`，不改变仓库既有的安全姿态。
- **Node 24 自带全局 `WebSocket` 客户端**（`node -e "console.log(typeof WebSocket)"` → `function`）。浏览器与 Electron 渲染层也原生具备。因此 `core-client` 可以继续保持零依赖。
- Node 没有内置的 WebSocket **服务端**，所以 `core-server` 需要 `ws`。
- 现有 `main.ts` 共 204 行，其中约 130 行（Pi 管理、账本、emit、权限确认、工作目录持久化）整体搬到 `core-server`；`dialog.showOpenDialog` 留在 Electron 侧（那是 GUI 能力）。

## 已知风险

**Electron 主进程里可能没有全局 `WebSocket`。** Electron 44 基于 Node 24，理论上有，但 Electron 对 Node 的全局对象有自己的处理，**未实测**。Task 4 Step 1 会先验证；若没有，退路是给 `desktop` 加 `ws` 依赖并用 `import { WebSocket } from "ws"`——`RemoteSession` 接受任何满足 `Socket` 接口的对象，所以只需换构造那一行。

## 3a 明确不做

网页界面、构建步骤、远程访问、鉴权、自动启动 core-server、断线重连。全部属于 3b。

**端口只监听 `127.0.0.1`。这是 3a 没有网络安全面的唯一依据，任何时候都不得改成 `0.0.0.0`。**

---

## 文件结构

```
packages/core-client/src/
├── protocol.ts          新增：线上消息类型 + 客户端消息校验
├── protocol.test.ts     新增
├── remote.ts            新增：RemoteSession（客户端侧）
├── remote.test.ts       新增
├── session.ts           修改：createSession 支持从快照重建
└── index.ts             修改：导出上述内容

packages/core-server/     新增包
├── package.json
└── src/index.ts         Pi + 账本 + ws 服务

packages/desktop/src/
└── main.ts              整份重写为中继（渲染层、preload 均不动）
```

---

## Task 1：协议与 RemoteSession（TDD）

**Files:**
- Create: `packages/core-client/src/protocol.ts`
- Test: `packages/core-client/src/protocol.test.ts`
- Create: `packages/core-client/src/remote.ts`
- Test: `packages/core-client/src/remote.test.ts`

- [ ] **Step 1: 写协议校验的失败测试**

`packages/core-client/src/protocol.test.ts`：

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClientMessage } from "./protocol.ts";

test("认得四种客户端消息", () => {
  assert.deepEqual(parseClientMessage({ type: "prompt", text: "你好" }), {
    type: "prompt",
    text: "你好",
  });
  assert.deepEqual(parseClientMessage({ type: "abort" }), { type: "abort" });
  assert.deepEqual(
    parseClientMessage({ type: "respond_confirm", requestId: "u1", confirmed: true }),
    { type: "respond_confirm", requestId: "u1", confirmed: true },
  );
  assert.deepEqual(parseClientMessage({ type: "set_project", cwd: "/tmp" }), {
    type: "set_project",
    cwd: "/tmp",
  });
});

test("字段类型不对的一律丢掉", () => {
  // 网络来的东西不可信。宁可丢掉也不能带着错的类型往下走。
  assert.equal(parseClientMessage({ type: "prompt", text: 123 }), undefined);
  assert.equal(parseClientMessage({ type: "respond_confirm", requestId: "u1" }), undefined);
  assert.equal(
    parseClientMessage({ type: "respond_confirm", requestId: 1, confirmed: true }),
    undefined,
  );
  assert.equal(parseClientMessage({ type: "set_project", cwd: "" }), undefined);
});

test("空白的 prompt 不算数", () => {
  assert.equal(parseClientMessage({ type: "prompt", text: "   " }), undefined);
});

test("不认识的东西丢掉，不崩", () => {
  assert.equal(parseClientMessage({ type: "rm -rf /" }), undefined);
  assert.equal(parseClientMessage(null), undefined);
  assert.equal(parseClientMessage("prompt"), undefined);
  assert.equal(parseClientMessage(42), undefined);
});
```

- [ ] **Step 2: 运行，确认失败**

```powershell
node --test "packages/core-client/src/protocol.test.ts"
```

期望：FAIL，报找不到模块 `./protocol.ts`。

- [ ] **Step 3: 写 protocol.ts**

```typescript
// 服务器与客户端之间的线上协议。
//
// 与 Pi 的 JSONL 协议是两回事：那个走 transport.ts / client.ts，携带 Pi 的原始事件；
// 这个携带已经折叠好的界面动作，层级更高。两边共用这一份定义，免得各写一遍慢慢对不上。

import type { ViewAction } from "./events.ts";
import type { Snapshot } from "./session.ts";

/** 客户端 → 服务器。 */
export type ClientMessage =
  | { type: "prompt"; text: string }
  | { type: "abort" }
  | { type: "respond_confirm"; requestId: string; confirmed: boolean }
  | { type: "set_project"; cwd: string };

/** 服务器 → 客户端。 */
export type ServerMessage =
  | { type: "snapshot"; snapshot: Snapshot; cwd: string }
  | { type: "actions"; actions: ViewAction[] }
  | { type: "reset"; cwd: string };

/**
 * 校验客户端来的消息，不认识就返回 undefined 让调用方丢掉。
 *
 * 网络上来的东西一律不可信，所以逐个字段查类型——哪怕现在只监听回环地址。
 * 等 3b 真的对外开口时，这道检查已经在了。
 */
export function parseClientMessage(raw: unknown): ClientMessage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const message = raw as Record<string, unknown>;

  switch (message.type) {
    case "prompt":
      if (typeof message.text !== "string" || message.text.trim() === "") return undefined;
      return { type: "prompt", text: message.text };

    case "abort":
      return { type: "abort" };

    case "respond_confirm":
      if (typeof message.requestId !== "string" || typeof message.confirmed !== "boolean") {
        return undefined;
      }
      return {
        type: "respond_confirm",
        requestId: message.requestId,
        confirmed: message.confirmed,
      };

    case "set_project":
      if (typeof message.cwd !== "string" || message.cwd === "") return undefined;
      return { type: "set_project", cwd: message.cwd };

    default:
      return undefined;
  }
}
```

- [ ] **Step 4: 运行，确认通过**

```powershell
node --test "packages/core-client/src/protocol.test.ts"
```

期望：4 个测试全部 pass。

- [ ] **Step 5: 写 RemoteSession 的失败测试**

`packages/core-client/src/remote.test.ts`：

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteSession } from "./remote.ts";
import type { Socket } from "./remote.ts";

/** 假的连接，用来在不起服务器的情况下测协议逻辑。 */
function createFakeSocket(): { socket: Socket; sent: string[]; receive: (obj: unknown) => void } {
  const sent: string[] = [];
  const socket: Socket = {
    send: (data) => sent.push(data),
    onmessage: null,
  };
  return {
    socket,
    sent,
    receive: (obj) => socket.onmessage?.({ data: JSON.stringify(obj) }),
  };
}

test("四种命令都按协议发出去", () => {
  const fake = createFakeSocket();
  const remote = new RemoteSession(fake.socket, {});

  remote.prompt("你好");
  remote.abort();
  remote.respondConfirm("u1", false);
  remote.setProject("/tmp");

  assert.deepEqual(fake.sent.map((line) => JSON.parse(line)), [
    { type: "prompt", text: "你好" },
    { type: "abort" },
    { type: "respond_confirm", requestId: "u1", confirmed: false },
    { type: "set_project", cwd: "/tmp" },
  ]);
});

test("快照与动作分别交给对应的处理器", () => {
  const fake = createFakeSocket();
  const snapshots: unknown[] = [];
  const batches: unknown[] = [];
  const resets: string[] = [];

  new RemoteSession(fake.socket, {
    onSnapshot: (snapshot, cwd) => snapshots.push([snapshot, cwd]),
    onActions: (actions) => batches.push(actions),
    onReset: (cwd) => resets.push(cwd),
  });

  const snapshot = { entries: [], totalTokens: 0, totalCost: 0, busy: false };
  fake.receive({ type: "snapshot", snapshot, cwd: "/home/me" });
  fake.receive({ type: "actions", actions: [{ type: "busy_changed", busy: true }] });
  fake.receive({ type: "reset", cwd: "/tmp" });

  assert.deepEqual(snapshots, [[snapshot, "/home/me"]]);
  assert.deepEqual(batches, [[{ type: "busy_changed", busy: true }]]);
  assert.deepEqual(resets, ["/tmp"]);
});

test("坏消息被忽略，不崩", () => {
  const fake = createFakeSocket();
  new RemoteSession(fake.socket, { onActions: () => assert.fail("不该被调用") });

  fake.socket.onmessage?.({ data: "这不是 JSON" });
  fake.socket.onmessage?.({ data: 42 });
  fake.receive({ type: "没听过的类型" });
});
```

- [ ] **Step 6: 运行，确认失败**

```powershell
node --test "packages/core-client/src/remote.test.ts"
```

期望：FAIL，报找不到模块 `./remote.ts`。

- [ ] **Step 7: 写 remote.ts**

```typescript
// 客户端这一侧的连接。
//
// 与 CoreClient 并列，不是叠加：CoreClient 说的是 Pi 的 JSONL 协议，
// 这个说的是本项目服务器与客户端之间的协议。

import type { ViewAction } from "./events.ts";
import type { Snapshot } from "./session.ts";
import type { ClientMessage, ServerMessage } from "./protocol.ts";

/**
 * 一个能收发文本消息的连接。
 *
 * 原生 WebSocket 正好满足这个形状——浏览器、Electron 渲染层、Node 24 都有它，
 * 所以本模块不引入任何依赖。测试时喂一个假的即可。
 */
export type Socket = {
  send(data: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
};

export type RemoteHandlers = {
  onSnapshot?: (snapshot: Snapshot, cwd: string) => void;
  onActions?: (actions: ViewAction[]) => void;
  onReset?: (cwd: string) => void;
};

export class RemoteSession {
  #socket: Socket;
  #handlers: RemoteHandlers;

  constructor(socket: Socket, handlers: RemoteHandlers) {
    this.#socket = socket;
    this.#handlers = handlers;
    socket.onmessage = (event) => this.#receive(event.data);
  }

  prompt(text: string): void {
    this.#send({ type: "prompt", text });
  }

  abort(): void {
    this.#send({ type: "abort" });
  }

  respondConfirm(requestId: string, confirmed: boolean): void {
    this.#send({ type: "respond_confirm", requestId, confirmed });
  }

  setProject(cwd: string): void {
    this.#send({ type: "set_project", cwd });
  }

  #send(message: ClientMessage): void {
    this.#socket.send(JSON.stringify(message));
  }

  #receive(data: unknown): void {
    if (typeof data !== "string") return;

    let message: ServerMessage;
    try {
      message = JSON.parse(data) as ServerMessage;
    } catch {
      return; // 非 JSON 直接忽略
    }

    switch (message.type) {
      case "snapshot":
        this.#handlers.onSnapshot?.(message.snapshot, message.cwd);
        return;
      case "actions":
        this.#handlers.onActions?.(message.actions);
        return;
      case "reset":
        this.#handlers.onReset?.(message.cwd);
        return;
      default:
        return;
    }
  }
}
```

- [ ] **Step 8: 运行，确认通过**

```powershell
node --test "packages/core-client/src/remote.test.ts"
```

期望：3 个测试全部 pass。

- [ ] **Step 9: 提交**

```powershell
git add -A
git commit -m "feat(core-client): wire protocol and RemoteSession"
```

---

## Task 2：账本可从快照重建（TDD）

**Files:**
- Modify: `packages/core-client/src/session.ts`
- Test: `packages/core-client/src/session.test.ts`
- Modify: `packages/core-client/src/index.ts`

**为什么需要：** GUI 主进程连上服务器时收到一份快照，之后只收到增量动作。用户按 Ctrl+R 刷新时，
渲染层会向主进程索取快照——主进程必须能给出**当前**的，而不是连接那一刻的。所以主进程要持有
一份镜像账本：用初始快照开局，之后把收到的动作照样 apply 一遍。

- [ ] **Step 1: 写失败的测试**

在 `packages/core-client/src/session.test.ts` 末尾追加：

```typescript
test("可以从一份快照重建账本", () => {
  // 客户端侧持有的是镜像：拿服务器给的快照开局，之后跟着动作走。
  const origin = createSession();
  origin.apply({ type: "message_added", messageId: "m1", role: "user" });
  origin.apply({ type: "text_appended", messageId: "m1", text: "你好" });
  origin.apply({ type: "usage_changed", totalTokens: 120, totalCost: 0.004 });

  const mirror = createSession(origin.snapshot());

  assert.deepEqual(mirror.snapshot(), origin.snapshot());
});

test("重建出来的账本能继续接收动作", () => {
  const origin = createSession();
  origin.apply({ type: "message_added", messageId: "m1", role: "assistant" });

  const mirror = createSession(origin.snapshot());
  mirror.apply({ type: "text_appended", messageId: "m1", text: "继续" });

  assert.equal(mirror.snapshot().entries[0].text, "继续");
});
```

- [ ] **Step 2: 运行，确认失败**

```powershell
node --test "packages/core-client/src/session.test.ts"
```

期望：FAIL，「可以从一份快照重建账本」那条报 entries 不相等（`createSession` 忽略了参数）。

- [ ] **Step 3: 改实现**

把 `packages/core-client/src/session.ts` 里的 `createSession` 开头三行：

```typescript
export function createSession(): Session {
  const entries: Entry[] = [];
  let totalTokens = 0;
  let totalCost = 0;
  let busy = false;
```

替换为：

```typescript
/**
 * @param initial 用一份快照开局。客户端侧持有镜像账本时用得上：
 *                连上服务器先拿一份快照，之后跟着增量动作走。
 */
export function createSession(initial?: Snapshot): Session {
  // 复制一份，免得调用方后续改动那个快照影响到这里。
  const entries: Entry[] = (initial?.entries ?? []).map((entry) => ({ ...entry }));
  let totalTokens = initial?.totalTokens ?? 0;
  let totalCost = initial?.totalCost ?? 0;
  let busy = initial?.busy ?? false;
```

- [ ] **Step 4: 运行，确认通过**

```powershell
node --test "packages/core-client/src/session.test.ts"
```

期望：13 个测试全部 pass。

- [ ] **Step 5: 更新对外导出**

把 `packages/core-client/src/index.ts` 整个替换为：

```typescript
export { CoreClient } from "./client.ts";
export type {
  CoreEvent,
  CoreResponse,
  UiReply,
  UiRequest,
  UiRequestHandler,
} from "./client.ts";
export { createEventFolder, foldUiRequest } from "./events.ts";
export type { ToolStatus, ViewAction } from "./events.ts";
export { parseClientMessage } from "./protocol.ts";
export type { ClientMessage, ServerMessage } from "./protocol.ts";
export { RemoteSession } from "./remote.ts";
export type { RemoteHandlers, Socket } from "./remote.ts";
export { createSession } from "./session.ts";
export type {
  Entry,
  MessageEntry,
  NoticeEntry,
  Session,
  Snapshot,
  ToolEntry,
} from "./session.ts";
export { StdioTransport } from "./transport.ts";
export type { Transport } from "./transport.ts";
```

- [ ] **Step 6: 跑全部测试**

```powershell
node --test "packages/core-host/src/*.test.ts" "packages/core-client/src/*.test.ts"
```

期望：45 个测试全部 pass（原 36 个 + Task 1 的 7 个 + 本任务的 2 个）。

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "feat(core-client): rebuild a session ledger from a snapshot"
```

---

## Task 3：core-server

**Files:**
- Create: `packages/core-server/package.json`
- Create: `packages/core-server/src/index.ts`

这个文件里大约 130 行是从 `main.ts` 搬过来的，行为不变；改动只在两处：
输出从「发 IPC 给窗口」变成「广播给所有连接」，配置文件位置从 Electron 的 userData
变成 `~/.cinba/`。

- [ ] **Step 1: 创建包**

`packages/core-server/package.json`：

```json
{
  "name": "@cinba/core-server",
  "private": true,
  "type": "module",
  "version": "0.0.0",
  "dependencies": {
    "@cinba/core-client": "*",
    "@cinba/core-host": "*",
    "ws": "^8.21.3"
  }
}
```

- [ ] **Step 2: 写服务器**

`packages/core-server/src/index.ts`：

```typescript
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  }
}

// ---- 起服务 ----

cwd = loadCwd();
startSession();

const server = new WebSocketServer({ host: HOST, port: PORT });

server.on("listening", () => {
  console.log(`[cinba] 服务已启动 ws://${HOST}:${PORT}`);
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
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

- [ ] **Step 3: 安装**

```powershell
npm install
```

期望：`node_modules/ws` 出现。用这条确认：

```powershell
Test-Path node_modules\ws\index.js
```

期望 `True`。

- [ ] **Step 4: 起服务，确认能听**

```powershell
node packages\core-server\src\index.ts
```

期望终端出现：

```
[cinba] 服务已启动 ws://127.0.0.1:4517
[cinba] 工作目录 C:\Users\shenxichen
```

**先别关掉**，下一步要用。

- [ ] **Step 5: 另开一个终端，用一次性脚本验证收发**

**用文件，不要用 `node -e`。** 阶段 1b 实测过：PowerShell 5.1 会吃掉命令行字符串里的双引号，
`-e` 传长代码必然出错。

新建 `packages/core-server/tmp-probe.mjs`（验证完就删）：

```javascript
const ws = new WebSocket("ws://127.0.0.1:4517");
ws.onmessage = (event) => console.log(String(event.data).slice(0, 200));
ws.onopen = () => ws.send(JSON.stringify({ type: "prompt", text: "说一个字：好" }));
setTimeout(() => process.exit(0), 25000);
```

新开一个 PowerShell 窗口：

```powershell
cd C:\Users\shenxichen\repos\Cinba
node packages\core-server\tmp-probe.mjs
```

期望：

1. 立刻打出一条 `{"type":"snapshot",...}`
2. 随后陆续打出若干 `{"type":"actions","actions":[...]}`，其中能看到 `message_added`、`text_appended`
3. 服务器那个窗口打出「客户端接入，当前 1 个」

验证完删掉这个临时文件：

```powershell
Remove-Item packages\core-server\tmp-probe.mjs
```

- [ ] **Step 6: Ctrl+C 停掉服务器，确认没有残留**

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*rpc-entry*' } | Measure-Object | Select-Object -ExpandProperty Count
```

期望 `0`。

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "feat(core-server): local core service over loopback WebSocket"
```

---

## Task 4：GUI 改成客户端

**Files:**
- Modify: `packages/desktop/package.json`
- Modify: `packages/desktop/src/main.ts`（整份重写）
- 不动：`preload.js`、`renderer/`（**IPC 契约完全不变**）

- [ ] **Step 1: 先验证 Electron 主进程有没有全局 WebSocket**

这是本任务唯一的未知数，先拆雷。临时把 `packages/desktop/src/main.ts` 第一行改成：

```typescript
console.log("[probe] WebSocket 是", typeof WebSocket);
```

（加在文件最开头，其余不动。）然后：

```powershell
npm start --workspace @cinba/desktop
```

期望终端出现 `[probe] WebSocket 是 function`。

**若是 `undefined`**：给 `packages/desktop/package.json` 的 dependencies 加上 `"ws": "^8.21.3"`，
并在下一步的 main.ts 里把 `new WebSocket(SERVER_URL)` 改成先 `import { WebSocket } from "ws";`。
`RemoteSession` 接受任何满足 `Socket` 接口的对象，所以只需换这一行。

验证完把这行 `console.log` 删掉。

- [ ] **Step 2: 改 desktop 的依赖**

`packages/desktop/package.json` 整份替换为：

```json
{
  "name": "@cinba/desktop",
  "private": true,
  "type": "module",
  "version": "0.0.0",
  "main": "./src/main.ts",
  "scripts": {
    "start": "electron ."
  },
  "dependencies": {
    "@cinba/core-client": "*"
  },
  "devDependencies": {
    "electron": "^44.2.0"
  }
}
```

`@cinba/core-host` 被移除了——Pi 不再归 GUI 管。**这一步让 `desktop` 回到设计文档
第 5 节要求的形状：它只是前端。**

- [ ] **Step 3: 整份重写 main.ts**

```typescript
// Electron 主进程。
//
// 3a 之后它只是个中继：连上 core-server，把收到的动作经原有的 IPC 通道转给渲染层。
// Pi 与账本都不在这里了，唯一真相在 core-server。
//
// 渲染层与 preload 完全不动——IPC 契约保持原样，所以界面无感。
// 等 3b 做共用界面时，渲染层会直接连服务器，这一层中继随之消失。

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { fileURLToPath } from "node:url";
import { RemoteSession, createSession } from "@cinba/core-client";
import type { Session } from "@cinba/core-client";

const SERVER_URL = "ws://127.0.0.1:4517";

let window: BrowserWindow | undefined;
let remote: RemoteSession | undefined;

/**
 * 镜像账本。服务器才是唯一真相，这里只是一份副本——
 * 渲染层按 Ctrl+R 刷新时会来要快照，那时必须给出当前的，而不是连接那一刻的。
 */
let mirror: Session = createSession();

let cwd = "";

/** 首份快照到达之前，getSnapshot 之类的请求先挂着。 */
let ready: Promise<void>;
let markReady: () => void = () => {};

function connect(): void {
  ready = new Promise((resolve) => {
    markReady = resolve;
  });

  const socket = new WebSocket(SERVER_URL);

  socket.addEventListener("error", () => {
    dialog.showErrorBox(
      "连不上 Cinba 服务",
      `请先启动核心服务：\n\nnode <仓库路径>/packages/core-server/src/index.ts\n\n然后重新打开本程序。`,
    );
  });

  remote = new RemoteSession(socket, {
    onSnapshot: (snapshot, nextCwd) => {
      mirror = createSession(snapshot);
      cwd = nextCwd;
      markReady();
    },
    onActions: (actions) => {
      for (const action of actions) mirror.apply(action);
      window?.webContents.send("cinba:actions", actions);
    },
    onReset: (nextCwd) => {
      cwd = nextCwd;
      window?.webContents.send("cinba:reset", nextCwd);
    },
  });
}

app.whenReady().then(() => {
  connect();

  window = new BrowserWindow({
    width: 980,
    height: 760,
    title: "Cinba",
    webPreferences: {
      preload: fileURLToPath(import.meta.resolve("./preload.js")),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  void window.loadFile(fileURLToPath(import.meta.resolve("./renderer/index.html")));
});

// 关窗口只关窗口。core-server 是独立进程，继续跑着——这正是 3a 想要的。
app.on("window-all-closed", () => app.quit());

// ---- 渲染层来的请求 ----
// IPC 契约与阶段 1b 完全一致，只是实现从「自己干」变成了「转给服务器」。

ipcMain.handle("cinba:getSnapshot", async () => {
  await ready;
  return mirror.snapshot();
});

ipcMain.handle("cinba:getProject", async () => {
  await ready;
  return cwd;
});

ipcMain.handle("cinba:prompt", (_event: IpcMainInvokeEvent, text: unknown) => {
  if (typeof text !== "string" || text.trim() === "") return;
  remote?.prompt(text);
});

ipcMain.handle("cinba:abort", () => {
  remote?.abort();
});

ipcMain.handle(
  "cinba:respondConfirm",
  (_event: IpcMainInvokeEvent, requestId: unknown, confirmed: unknown) => {
    if (typeof requestId !== "string" || typeof confirmed !== "boolean") return;
    remote?.respondConfirm(requestId, confirmed);
  },
);

ipcMain.handle("cinba:chooseProject", async () => {
  if (!window) return cwd;
  // 文件夹选择器是 GUI 的能力，留在这一侧；选完把路径告诉服务器。
  // 注意：这依然假设了服务器与界面在同一台机器上。3b 做远程时必须重做——
  // 主设计文档第 8 节把这条记为「必须重做，不是可选优化」。
  const result = await dialog.showOpenDialog(window, {
    title: "选择项目目录",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return cwd;

  remote?.setProject(result.filePaths[0]!);
  return result.filePaths[0]!;
});
```

- [ ] **Step 4: 验证行为与之前完全一致**

先起服务（一个终端）：

```powershell
node packages\core-server\src\index.ts
```

再起 GUI（另一个终端）：

```powershell
npm start --workspace @cinba/desktop
```

逐项确认——**这些全是阶段 1b 已经验收过的行为，3a 不该让任何一条退化**：

- [ ] 纯对话能问能答，逐字流式显示，输入框在回答期间锁定
- [ ] 费用与 token 随对话增长
- [ ] 触发 bash 时出现待批准卡片，点「允许」执行、点「拒绝」不执行且模型知道被拒
- [ ] Esc 与「中止」按钮都能打断，出现「已中止」胶囊
- [ ] thinking 默认收起可展开
- [ ] 切换项目后对话清空，新目录生效
- [ ] **按 Ctrl+R 刷新后对话完整恢复**（这条验的是镜像账本）

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "feat(desktop): become a client of core-server"
```

---

## Task 5：多客户端与生命周期验收

**Files:**
- Create: `scripts/watch.ts`

- [ ] **Step 1: 写一个旁观客户端**

它既是多客户端的验证工具，也留作以后调试用——跟 `scripts/probe.ts` 一个性质。

`scripts/watch.ts`：

```typescript
// 旁观 core-server 的会话：连上去，把收到的东西打出来，不发任何命令。
//
// 用途一：验证多客户端（GUI 在用，这个在旁边看）。
// 用途二：以后调试协议时的探针。
//
// 用法：node scripts/watch.ts

import { RemoteSession } from "@cinba/core-client";

const socket = new WebSocket("ws://127.0.0.1:4517");

socket.addEventListener("error", () => {
  console.error("连不上 ws://127.0.0.1:4517，core-server 起了吗？");
  process.exit(1);
});

new RemoteSession(socket, {
  onSnapshot: (snapshot, cwd) => {
    console.log(`[快照] 工作目录=${cwd} 条目=${snapshot.entries.length} ` +
      `tokens=${snapshot.totalTokens} busy=${snapshot.busy}`);
  },
  onActions: (actions) => {
    for (const action of actions) {
      if (action.type === "text_appended") {
        process.stdout.write(action.text);
      } else {
        console.log(`\n[动作] ${JSON.stringify(action).slice(0, 160)}`);
      }
    }
  },
  onReset: (cwd) => console.log(`\n[重置] 工作目录=${cwd}`),
});

console.log("旁观中，Ctrl+C 退出");
```

- [ ] **Step 2: 验证多客户端**

三个终端：服务器、GUI、旁观者。

```powershell
node scripts\watch.ts
```

在 GUI 里问一句话。期望：

1. 旁观者先打出一行 `[快照]`，条目数与 GUI 里已有的对话一致
2. GUI 里模型逐字输出的同时，**旁观者这边同步打出同样的文字**
3. 旁观者打出 `[动作] {"type":"busy_changed"...}` 等

这验证了动作广播给所有连接——**3b 手机接入靠的就是这条**。

- [ ] **Step 3: 验证中途接入能看到历史**

先关掉旁观者（Ctrl+C），在 GUI 里再问一两句，然后重新启动旁观者。

期望：`[快照]` 那行的条目数包含了刚才新增的对话——**中途连进来的客户端能补上错过的内容**。

- [ ] **Step 4: 验证生命周期**

- [ ] 关掉 GUI 窗口 → 服务器窗口打出「客户端断开」，**服务器继续运行**，旁观者也继续
- [ ] 重新启动 GUI → 能看到关窗口之前的完整对话
- [ ] Ctrl+C 停掉服务器 → 打出「正在关闭，回收 Pi 子进程」

停掉之后：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*rpc-entry*' } | Measure-Object | Select-Object -ExpandProperty Count
```

期望 `0`。

- [ ] **Step 5: 确认 TUI 未受影响**

TUI 走的是自己的 stdio 链路，与 core-server 无关，但共用 `core-client`，仍需确认一次。

```powershell
node packages\tui\src\index.ts
```

问一句话，权限确认试一次，Ctrl+C 退出。

- [ ] **Step 6: 跑全部测试**

```powershell
node --test "packages/core-host/src/*.test.ts" "packages/core-client/src/*.test.ts"
```

期望：45 个全部 pass。

- [ ] **Step 7: 更新文档并提交**

把本文件的进度表标为完成，勾上设计文档第 7 节的清单，并在设计文档
`docs/specs/2026-09-06-cinba-design.md` 第 8 节把待解问题「`desktop` 同时扮演前端与核心侧」
标记为已解决（3a 拆分后 `desktop` 只依赖 `core-client`）。

```powershell
git add -A
git commit -m "docs: mark phase 3a complete"
```

---

## 阶段 3a 完成标准

- [ ] `node --test` 45 个全绿
- [ ] Task 4 Step 4 的七项行为与阶段 1b 完全一致，无退化
- [ ] Task 5 的多客户端与生命周期各项通过
- [ ] `desktop` 不再依赖 `core-host`
- [ ] 服务只监听 `127.0.0.1`
- [ ] 渲染层与 `preload.js` 一行未改

达成后进阶段 3b：网页界面、构建步骤、远程接入。
