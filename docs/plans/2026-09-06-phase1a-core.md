# 阶段 1a：核心层与协议层 实施计划

**目标：** 搭出 `core-host` + `core-client` + 权限门，产出一条能在终端里跑通的完整链路——输入一句话，模型要执行命令时停下来问你，你答 y/n。没有图形界面，但架构上的每一环都在。

**架构：** monorepo，两个包。`core-host` 负责启动并配置 Pi 进程；`core-client` 负责跨进程双向通信（发命令、收事件、回应 extension UI 请求）。权限门是一个 Pi extension，跑在核心侧。

**技术栈：** Node 24（原生执行 `.ts`，无构建步骤）、npm workspaces、`node --test`（内置测试运行器，零依赖）。

---

## 进度（截至 2026-09-06 收工）

| Task | 状态 |
|---|---|
| 1. workspace 骨架 | ✅ 完成并验证（符号链接已建立，`rpc-entry` 可从本地解析） |
| 2. core-host | ✅ 完成并验证（手工验证跑通完整事件流，无 DEP0190 警告） |
| 3. 切行 | ✅ 完成，4 个测试通过 |
| 4. Transport | ✅ 完成 |
| 5. CoreClient | ✅ 完成，4 个测试通过（合计 8 个） |
| 6. 权限门 | ✅ 完成 |
| 7. 端到端验证 | ⚠️ 机制已验证（脚本化答 y/n 均符合预期），**但 `rl.question` 的交互路径待你在真实终端里手动确认一次** |

本轮新增备注：

- `node --test <目录>` 在 Node 24 上**不会**发现 `.ts` 测试文件（它会把目录名当模块加载并报 `MODULE_NOT_FOUND`）。必须用 glob：`node --test "packages/core-client/src/*.test.ts"`。计划中相关命令已改。
- 用管道给 `scripts/repl.ts` 喂答案（`echo y | node scripts/repl.ts ...`）会失败：stdin 在 confirm 请求到达前就 EOF 了，readline 关闭后再 `question()` 报 `ERR_USE_AFTER_CLOSE`。这是管道的性质，不是代码 bug——真实终端里 stdin 不关。自动化验证要绕开 readline。

环境备注：

- provider 用 DeepSeek，`DEEPSEEK_API_KEY` 已设为用户级环境变量
- `npm install` 时有 3 个包的安装脚本被 npm 拦下未执行（`@google/genai`、`esbuild`、`protobufjs`）。**这是刻意保持的安全姿态**，暂不批准。若将来报错提到 esbuild 缺少二进制，再用 `npm approve-scripts` 单独放行

---

## 阶段 0 已验证的事实（本计划的依据）

- Pi 包的 exports 映射里有 `./rpc-entry` → `dist/bundle/rpc-entry.js`，**专供 Node 直接启动**。实测 `node rpc-entry.js --provider deepseek` 可用，不需要 shell，不需要 `--mode rpc`，无 DEP0190 警告。
- `./rpc-entry` 只声明了 `import` 条件，**CJS 的 `require.resolve` 会报 `ERR_PACKAGE_PATH_NOT_EXPORTED`**，必须用 ESM 的 `import.meta.resolve`。
- Extension UI 子协议：stdout 发 `extension_ui_request`（含 `id`、`method`），stdin 回 `extension_ui_response`（同 `id`）。阻塞式方法为 `select` / `confirm` / `input` / `editor`；`notify` 等为广播式，不需回应。
- `tool_call` 事件字段：`toolName`、`toolCallId`、`input`（可改）。返回 `{ block: true, reason }` 即可拦截。
- `agent_settled` 是"可接受新输入"的信号。
- **`rpc-entry` 接受 `-e <路径>` 加载扩展**（已实测，不只是 `pi` 命令支持）。
- **`confirm` 类型的 UI 请求字段为 `title` 和 `message`**（已实测）。
- **权限门确认有效**（已实测）：故意延迟 1.5 秒应答，`tool_execution_end` 就晚 1.5 秒到；答 `confirmed:false` 后工具未执行，`isError: true` 且 `result` 为拒绝理由，该结果回传给模型。

### ⚠️ `tool_execution_start` 的语义

它表示"**开始处理**这次工具调用"，**不表示已经执行**。实测顺序是 `tool_execution_start` → `extension_ui_request` → （等待用户）→ `tool_execution_end`。

**对 GUI 的影响：** 收到 `tool_execution_start` 时应渲染为"请求中/待批准"，绝不能渲染成"已执行"。最终状态以 `tool_execution_end` 的 `isError` 为准。

---

## TypeScript 写法约束（重要）

Node 的类型剥离只**擦除**类型，不做任何转换。以下 TS 语法会直接报错，本计划全程避免：

- ❌ 构造函数参数属性（`constructor(private x: T)`）
- ❌ `enum`、`namespace`、装饰器

用普通字段声明加显式赋值代替。`interface`、`type`、类型注解、`implements`、`#private` 字段都可以正常用。

---

## 文件结构

```
Cinba/
├── package.json                    # 加 workspaces 字段
├── tsconfig.base.json              # 共享 TS 配置（仅供编辑器用，不参与运行）
└── packages/
    ├── core-host/
    │   ├── package.json
    │   └── src/index.ts            # startCore()
    ├── core-client/
    │   ├── package.json
    │   └── src/
    │       ├── line-splitter.ts    # JSONL 切行（纯函数，可单测）
    │       ├── line-splitter.test.ts
    │       ├── transport.ts        # Transport 接口 + StdioTransport
    │       ├── client.ts           # CoreClient：命令/响应配对、事件分发、UI 应答
    │       ├── client.test.ts
    │       └── index.ts            # 对外导出
    └── extensions/
        ├── package.json
        └── src/permission-gate.ts  # 权限门
```

职责边界：`line-splitter` 只管切行；`transport` 只管字节进出；`client` 只管协议语义。三者可独立测试。

---

## Task 1：workspace 骨架

**Files:**
- Modify: `package.json`
- Create: `tsconfig.base.json`
- Create: `packages/core-host/package.json`
- Create: `packages/core-client/package.json`
- Create: `packages/extensions/package.json`

- [ ] **Step 1: 根 package.json 加 workspaces**

```json
{
  "name": "cinba",
  "private": true,
  "type": "module",
  "version": "0.0.0",
  "workspaces": [
    "packages/*"
  ]
}
```

`workspaces` 告诉 npm："`packages/` 下每个文件夹都是一个包，请把它们的依赖装到根部的 `node_modules`，并让它们能按名字互相 import。"

- [ ] **Step 2: 创建 tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "nodenext",
    "strict": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true
  }
}
```

`erasableSyntaxOnly` 会在编辑器里就拦住上面禁用的那些 TS 语法，不用等运行时报错。`noEmit` 是因为我们不编译——这份配置只服务于类型检查和编辑器提示。

- [ ] **Step 3: 创建三个包的 package.json**

`packages/core-host/package.json`：

```json
{
  "name": "@cinba/core-host",
  "private": true,
  "type": "module",
  "version": "0.0.0",
  "exports": "./src/index.ts",
  "dependencies": {
    "@earendil-works/pi-coding-agent": "^0.85.1"
  }
}
```

`packages/core-client/package.json`：

```json
{
  "name": "@cinba/core-client",
  "private": true,
  "type": "module",
  "version": "0.0.0",
  "exports": "./src/index.ts"
}
```

`packages/extensions/package.json`：

```json
{
  "name": "@cinba/extensions",
  "private": true,
  "type": "module",
  "version": "0.0.0",
  "dependencies": {
    "@earendil-works/pi-coding-agent": "^0.85.1"
  }
}
```

注意 `"exports": "./src/index.ts"` —— 直接指向 TS 源文件。因为不编译，Node 直接执行源码。

`core-client` 没有依赖 Pi：它只需要类型，而类型可以在需要时从 `core-host` 侧传入。保持它对 Pi 零依赖，阶段 3 换 WebSocket 时它能独立存在。

- [ ] **Step 4: 安装**

```bash
npm install
```

期望：根目录出现 `node_modules/`，其中有 `@earendil-works/pi-coding-agent`，以及指向三个本地包的符号链接。

- [ ] **Step 5: 验证本地包能互相解析**

```bash
node --input-type=module -e "console.log(import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'))"
```

期望：打印出一个以 `dist/bundle/rpc-entry.js` 结尾的 `file://` URL。

若报 `ERR_MODULE_NOT_FOUND`，说明 npm install 没装上；若报 `ERR_PACKAGE_PATH_NOT_EXPORTED`，说明用错了解析方式（必须是 ESM 的 `import.meta.resolve`，不是 `require.resolve`）。

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "chore: 建立 npm workspaces 骨架"
```

---

## Task 2：core-host

**Files:**
- Create: `packages/core-host/src/index.ts`

- [ ] **Step 1: 写 startCore()**

```typescript
// 「我的核心」的定义：怎么启动 Pi、用哪个 provider/model、加载哪些扩展。
// 三端共用这一份，保证醒来的永远是同一个大脑。

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export type CoreOptions = {
  /** 工作目录。Pi 的会话按工作目录隔离，所以这决定了"当前是哪个项目"。 */
  cwd?: string;
  /** 模型厂商。默认 deepseek。 */
  provider?: string;
  /** 模型 id。不填则用该 provider 的默认模型。 */
  model?: string;
  /** 要加载的 extension 文件路径列表。 */
  extensions?: string[];
};

const DEFAULT_PROVIDER = "deepseek";

/**
 * 启动 Pi 的 RPC 进程。
 *
 * 用 Node 直接执行 Pi 的 rpc-entry，而不是 spawn "pi" 命令：
 * Windows 上 pi 实际是 pi.cmd，Node 18.20+ 禁止直接 spawn .cmd（报 EINVAL），
 * 用 shell: true 绕过则会触发 DEP0190 弃用警告。直接跑入口 JS 两个问题都没有。
 */
export function startCore(options: CoreOptions = {}): ChildProcess {
  const entry = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"),
  );

  const args: string[] = ["--provider", options.provider ?? DEFAULT_PROVIDER];

  if (options.model) {
    args.push("--model", options.model);
  }

  for (const extension of options.extensions ?? []) {
    args.push("-e", extension);
  }

  return spawn(process.execPath, [entry, ...args], {
    cwd: options.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "inherit"],
  });
}
```

`import.meta.resolve` 返回的是 `file://` URL，`spawn` 需要普通路径，所以要过一道 `fileURLToPath`。

- [ ] **Step 2: 手工验证能启动**

```bash
node --input-type=module -e "
import { startCore } from '@cinba/core-host';
const p = startCore();
p.stdout.on('data', c => process.stdout.write(c));
p.stdin.write(JSON.stringify({ type: 'prompt', message: '说一个字：好' }) + '\n');
setTimeout(() => p.kill(), 25000);
"
```

期望：屏幕上出现一串 JSONL 事件行，能看到 `agent_start`、`message_update`、`agent_settled`。

- [ ] **Step 3: 提交**

```bash
git add -A && git commit -m "feat(core-host): 启动并配置 Pi RPC 进程"
```

---

## Task 3：切行（TDD）

**Files:**
- Create: `packages/core-client/src/line-splitter.ts`
- Test: `packages/core-client/src/line-splitter.test.ts`

- [ ] **Step 1: 先写失败的测试**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLineSplitter } from "./line-splitter.ts";

test("一个 chunk 里的多行全部切出", () => {
  const lines: string[] = [];
  const feed = createLineSplitter((line) => lines.push(line));

  feed('{"a":1}\n{"b":2}\n');

  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("跨 chunk 的半行会被拼回来", () => {
  const lines: string[] = [];
  const feed = createLineSplitter((line) => lines.push(line));

  feed('{"a":');
  assert.deepEqual(lines, [], "还没遇到换行，不该吐出任何东西");

  feed('1}\n');
  assert.deepEqual(lines, ['{"a":1}']);
});

test("空行被忽略", () => {
  const lines: string[] = [];
  const feed = createLineSplitter((line) => lines.push(line));

  feed('\n\n{"a":1}\n');

  assert.deepEqual(lines, ['{"a":1}']);
});

test("不把 Unicode 行分隔符当换行", () => {
  const lines: string[] = [];
  const feed = createLineSplitter((line) => lines.push(line));

  //   是 Unicode 行分隔符。通用行读取器会在这里切一刀，
  // 把一条完整 JSON 切成两半。模型输出里完全可能出现这个字符。
  feed('{"text":"a b"}\n');

  assert.deepEqual(lines, ['{"text":"a b"}']);
});
```

- [ ] **Step 2: 运行，确认失败**

```bash
node --test packages/core-client/src/line-splitter.test.ts
```

期望：FAIL，报找不到模块 `./line-splitter.ts`。

- [ ] **Step 3: 写实现**

```typescript
// JSONL 切行。
//
// 为什么不用 readline：
// 1. 流给的是"一坨字节"不是"一行"，一次 data 可能是半行或三行半，必须自己攒。
// 2. Pi 文档明确要求只按 \n 切分。readline 这类通用读取器会把 Unicode
//    行分隔符也当换行，而模型输出里可能带这些字符，一旦误切 JSON 就断了。

/**
 * 造一个切行器。返回的函数每收到一块文本就调用一次，
 * 攒够完整的行（以 \n 结尾）就通过 onLine 吐出去。
 */
export function createLineSplitter(
  onLine: (line: string) => void,
): (chunk: string) => void {
  let buffer = "";

  return (chunk: string): void => {
    buffer += chunk;

    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim() !== "") onLine(line);
    }
  };
}
```

- [ ] **Step 4: 运行，确认通过**

```bash
node --test packages/core-client/src/line-splitter.test.ts
```

期望：4 个测试全部 pass。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(core-client): JSONL 切行"
```

---

## Task 4：Transport

**Files:**
- Create: `packages/core-client/src/transport.ts`

这一层只管"字节进出"，不认识任何协议语义。抽成接口是为了阶段 3 能换成 WebSocket 而不动上层。

- [ ] **Step 1: 写 Transport**

```typescript
import type { ChildProcess } from "node:child_process";
import { createLineSplitter } from "./line-splitter.ts";

/**
 * 传输层。只负责一行行地收发文本，不理解内容。
 * 阶段 3 会再实现一个 WebSocketTransport，上层代码不用改。
 */
export type Transport = {
  /** 发一行出去（实现负责补换行符）。 */
  send(line: string): void;
  /** 订阅收到的每一行。 */
  onLine(handler: (line: string) => void): void;
  /** 关闭连接。 */
  close(): Promise<void>;
};

/** 通过子进程的 stdin/stdout 通信。 */
export class StdioTransport {
  #child: ChildProcess;
  #handlers: Array<(line: string) => void> = [];

  constructor(child: ChildProcess) {
    this.#child = child;

    const feed = createLineSplitter((line) => {
      for (const handler of this.#handlers) handler(line);
    });

    if (!child.stdout) throw new Error("子进程没有 stdout，检查 spawn 的 stdio 配置");
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => feed(chunk));
  }

  send(line: string): void {
    if (!this.#child.stdin) throw new Error("子进程没有 stdin");
    // JSONL 靠 \n 分隔记录。漏了这个，对面会一直等下去。
    this.#child.stdin.write(line + "\n");
  }

  onLine(handler: (line: string) => void): void {
    this.#handlers.push(handler);
  }

  async close(): Promise<void> {
    this.#child.kill();
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add -A && git commit -m "feat(core-client): Transport 抽象与 stdio 实现"
```

---

## Task 5：CoreClient（TDD）

**Files:**
- Create: `packages/core-client/src/client.ts`
- Test: `packages/core-client/src/client.test.ts`
- Create: `packages/core-client/src/index.ts`

这是协议层的核心，三件事：发命令并等回执、把事件分发给订阅者、回应 extension UI 请求。

- [ ] **Step 1: 先写失败的测试**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { CoreClient } from "./client.ts";
import type { Transport } from "./transport.ts";

/** 假的传输层，用来在不启动 Pi 的情况下测协议逻辑。 */
function createFakeTransport(): {
  transport: Transport;
  sent: string[];
  receive: (obj: unknown) => void;
} {
  const sent: string[] = [];
  let handler: ((line: string) => void) | undefined;

  return {
    sent,
    receive: (obj) => handler?.(JSON.stringify(obj)),
    transport: {
      send: (line) => sent.push(line),
      onLine: (h) => { handler = h; },
      close: async () => {},
    },
  };
}

test("prompt 发出带 id 的命令，收到回执后 resolve", async () => {
  const fake = createFakeTransport();
  const client = new CoreClient(fake.transport);

  const pending = client.prompt("你好");

  assert.equal(fake.sent.length, 1);
  const command = JSON.parse(fake.sent[0]!);
  assert.equal(command.type, "prompt");
  assert.equal(command.message, "你好");
  assert.ok(command.id, "命令必须带 id 才能配对回执");

  fake.receive({ type: "response", command: "prompt", id: command.id, success: true });

  const response = await pending;
  assert.equal(response.success, true);
});

test("事件被分发给订阅者", () => {
  const fake = createFakeTransport();
  const client = new CoreClient(fake.transport);

  const seen: string[] = [];
  client.onEvent((event) => seen.push(event.type));

  fake.receive({ type: "agent_start" });
  fake.receive({ type: "agent_settled" });

  assert.deepEqual(seen, ["agent_start", "agent_settled"]);
});

test("阻塞式 UI 请求交给处理器，并把结果按 id 回传", async () => {
  const fake = createFakeTransport();
  const client = new CoreClient(fake.transport);

  client.onUiRequest(async (request) => {
    assert.equal(request.method, "confirm");
    return { confirmed: true };
  });

  fake.receive({
    type: "extension_ui_request",
    id: "uuid-1",
    method: "confirm",
    title: "执行 bash？",
  });

  // 等处理器这一轮微任务跑完
  await new Promise((resolve) => setImmediate(resolve));

  const reply = JSON.parse(fake.sent.at(-1)!);
  assert.equal(reply.type, "extension_ui_response");
  assert.equal(reply.id, "uuid-1");
  assert.equal(reply.confirmed, true);
});

test("广播式 UI 请求不回传任何东西", async () => {
  const fake = createFakeTransport();
  const client = new CoreClient(fake.transport);

  client.onUiRequest(async () => ({ confirmed: true }));

  fake.receive({
    type: "extension_ui_request",
    id: "uuid-2",
    method: "notify",
    message: "干活呢",
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fake.sent.length, 0, "notify 是广播式的，不该回话");
});
```

- [ ] **Step 2: 运行，确认失败**

```bash
node --test packages/core-client/src/client.test.ts
```

期望：FAIL，找不到 `./client.ts`。

- [ ] **Step 3: 写实现**

```typescript
import type { Transport } from "./transport.ts";

/** 需要客户端回话的 UI 方法。其余（notify、setStatus 等）是广播式的。 */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export type CoreEvent = { type: string; [key: string]: unknown };

export type CoreResponse = {
  type: "response";
  command: string;
  id?: string;
  success: boolean;
  [key: string]: unknown;
};

export type UiRequest = {
  type: "extension_ui_request";
  id: string;
  method: string;
  [key: string]: unknown;
};

/** 三种回应形态之一，见 Pi 的 RpcExtensionUIResponse。 */
export type UiReply =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

export type UiRequestHandler = (request: UiRequest) => Promise<UiReply>;

/**
 * 协议层客户端。
 *
 * 与 Pi 内置的 RpcClient 的区别：那个类的 send() 和 process 都是 private，
 * 无法把 extension_ui_response 写回 stdin，权限门因此无法工作。
 */
export class CoreClient {
  #transport: Transport;
  #pending = new Map<string, (response: CoreResponse) => void>();
  #eventListeners: Array<(event: CoreEvent) => void> = [];
  #uiHandler: UiRequestHandler | undefined;
  #nextId = 0;

  constructor(transport: Transport) {
    this.#transport = transport;
    this.#transport.onLine((line) => this.#handleLine(line));
  }

  /** 订阅事件流。返回取消订阅的函数。 */
  onEvent(listener: (event: CoreEvent) => void): () => void {
    this.#eventListeners.push(listener);
    return () => {
      const index = this.#eventListeners.indexOf(listener);
      if (index >= 0) this.#eventListeners.splice(index, 1);
    };
  }

  /** 注册 UI 请求处理器。前端在这里弹窗、拿用户的选择。 */
  onUiRequest(handler: UiRequestHandler): void {
    this.#uiHandler = handler;
  }

  prompt(message: string): Promise<CoreResponse> {
    return this.#send({ type: "prompt", message });
  }

  abort(): Promise<CoreResponse> {
    return this.#send({ type: "abort" });
  }

  close(): Promise<void> {
    return this.#transport.close();
  }

  #send(command: Record<string, unknown>): Promise<CoreResponse> {
    const id = String(++this.#nextId);
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#transport.send(JSON.stringify({ ...command, id }));
    });
  }

  #handleLine(line: string): void {
    let data: CoreEvent;
    try {
      data = JSON.parse(line) as CoreEvent;
    } catch {
      return; // 非 JSON 的行直接忽略
    }

    // 命令回执：按 id 找到等待中的 Promise
    if (data.type === "response" && typeof data.id === "string") {
      const resolve = this.#pending.get(data.id);
      if (resolve) {
        this.#pending.delete(data.id);
        resolve(data as CoreResponse);
        return;
      }
    }

    // extension UI 请求
    if (data.type === "extension_ui_request") {
      void this.#handleUiRequest(data as UiRequest);
      return;
    }

    // 其余都是事件
    for (const listener of this.#eventListeners) listener(data);
  }

  async #handleUiRequest(request: UiRequest): Promise<void> {
    // 广播式的方法照样交给处理器（前端可以显示通知），但不回话。
    const needsReply = DIALOG_METHODS.has(request.method);

    if (!this.#uiHandler) {
      // 没人处理阻塞式请求的话，核心会一直卡着，所以直接回"取消"。
      if (needsReply) {
        this.#transport.send(
          JSON.stringify({ type: "extension_ui_response", id: request.id, cancelled: true }),
        );
      }
      return;
    }

    const reply = await this.#uiHandler(request);
    if (!needsReply) return;

    this.#transport.send(
      JSON.stringify({ type: "extension_ui_response", id: request.id, ...reply }),
    );
  }
}
```

- [ ] **Step 4: 运行，确认通过**

```bash
node --test packages/core-client/src/client.test.ts
```

期望：4 个测试全部 pass。

- [ ] **Step 5: 写对外导出**

```typescript
export { CoreClient } from "./client.ts";
export type {
  CoreEvent,
  CoreResponse,
  UiReply,
  UiRequest,
  UiRequestHandler,
} from "./client.ts";
export { StdioTransport } from "./transport.ts";
export type { Transport } from "./transport.ts";
```

- [ ] **Step 6: 跑全部测试**

```bash
node --test "packages/core-client/src/*.test.ts"
```

期望：8 个测试全部 pass。

- [ ] **Step 7: 提交**

```bash
git add -A && git commit -m "feat(core-client): 协议客户端与 UI 应答通道"
```

---

## Task 6：权限门 extension

**Files:**
- Create: `packages/extensions/src/permission-gate.ts`

- [ ] **Step 1: 写权限门**

```typescript
// 权限门：模型每次要用工具，先问过用户。
//
// 必要性来自阶段 0 的实测：Pi 的 RPC 模式默认放行模型请求的一切工具调用，
// tool_call 之后直接执行，不会等客户端回话。没有这道门，等于把 shell 直接交出去。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 只读的工具，问了也是浪费用户的注意力，直接放行。 */
const AUTO_ALLOW = new Set(["read", "glob", "grep"]);

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (AUTO_ALLOW.has(event.toolName)) return;

    const detail = JSON.stringify(event.input, null, 2);
    const allowed = await ctx.ui.confirm(
      `允许执行 ${event.toolName}？`,
      detail,
    );

    if (!allowed) {
      return { block: true, reason: "用户拒绝了这次工具调用" };
    }
  });
}
```

`ctx.hasUI` 在 RPC 模式下是 `true`（因为对话框方法通过 UI 子协议可用），所以这道门在 GUI 和 TUI 里都有效。

`AUTO_ALLOW` 里放的是只读工具。写文件和执行命令一律要问——这是本项目的默认立场，将来觉得烦了再放宽，反过来会很危险。

- [ ] **Step 2: 提交**

```bash
git add -A && git commit -m "feat(extensions): 工具调用权限门"
```

---

## Task 7：端到端验证

**Files:**
- Create: `scripts/repl.ts`

一个最简终端交互程序，把前面所有零件串起来。它不是最终产品，是**证明链路通了**的证据，同时也是阶段 1b 写 GUI 时的参照实现。

- [ ] **Step 1: 写 repl.ts**

```typescript
// 阶段 1a 的端到端验证：把 core-host + core-client + 权限门串起来。
//
// 用法：node scripts/repl.ts "你的问题"

import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { startCore } from "@cinba/core-host";
import { CoreClient, StdioTransport } from "@cinba/core-client";

const gate = fileURLToPath(
  import.meta.resolve("@cinba/extensions/src/permission-gate.ts"),
);

const child = startCore({ extensions: [gate] });
const client = new CoreClient(new StdioTransport(child));

const rl = createInterface({ input: process.stdin, output: process.stdout });

// 权限确认：核心问什么，我们就在终端问用户
client.onUiRequest(async (request) => {
  if (request.method === "confirm") {
    console.log(`\n⚠️  ${String(request.title ?? "需要确认")}`);
    console.log(String(request.message ?? ""));
    const answer = await rl.question("允许？(y/N) ");
    return { confirmed: answer.trim().toLowerCase() === "y" };
  }
  if (request.method === "notify") {
    console.log(`[通知] ${String(request.message ?? "")}`);
    return { cancelled: true };
  }
  return { cancelled: true };
});

client.onEvent((event) => {
  if (event.type === "tool_execution_start") {
    console.log(`\n🔧 ${String(event.toolName)}`);
  }
  if (event.type === "agent_settled") {
    console.log("\n─── 完成 ───");
    void client.close().then(() => rl.close());
  }
  if (event.type === "message_end") {
    const message = event.message as { role?: string; content?: unknown } | undefined;
    if (message?.role === "assistant") {
      console.log(`\n${JSON.stringify(message.content)}`);
    }
  }
});

await client.prompt(process.argv[2] ?? "你好");
```

- [ ] **Step 2: 先跑一个不触发工具的**

```bash
node scripts/repl.ts "说一个字：好"
```

期望：打印助手消息，然后 `─── 完成 ───` 并退出。全程不该出现确认提示。

- [ ] **Step 3: 跑一个会触发 bash 的（关键验证）**

```bash
node scripts/repl.ts "运行 ls 命令，告诉我当前目录下有什么"
```

期望：

1. 出现 `⚠️ 允许执行 bash？` 和具体命令
2. **程序停下来等你输入** —— 这证明阻塞式 UI 请求真的把核心挂住了
3. 输入 `y` → 命令执行，模型给出回答
4. 再跑一次输入 `n` → 命令不执行，模型收到"用户拒绝"并据此回应

第 4 步是整个阶段 1a 最重要的验证：**它同时证明了权限门有效、UI 子协议双向通了、拦截结果真的回到了模型那里。**

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "feat: 端到端验证 REPL"
```

---

## 阶段 1a 完成标准

- [x] `npm install` 后三个本地包能互相 import
- [x] `node --test "packages/core-client/src/*.test.ts"` 全部通过（8/8）
- [x] `node scripts/repl.ts "说一个字：好"` 正常对话并退出
- [ ] `node scripts/repl.ts "运行 ls 命令..."` 会停下来问、答 `y` 执行、答 `n` 拒绝 ← 待人工跑一次
- [x] 全程没有 `shell: true`，没有 DEP0190 警告

达成后进阶段 1b（Electron GUI）。届时 `scripts/repl.ts` 里的那套事件处理逻辑，就是 GUI 渲染层的蓝本——把 `console.log` 换成往 DOM 里写，把 `rl.question` 换成弹窗。
