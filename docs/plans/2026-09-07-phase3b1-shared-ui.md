# 阶段 3b-1：共用界面 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一套 React 界面代码，Electron 与浏览器都加载它；`preload.js` 与全部 IPC 通道删除。

**Architecture:** 新增 `packages/web`（React + Vite）。`core-server` 在同一端口上同时提供 WebSocket 与静态文件，界面直接连 WebSocket——和浏览器走完全相同的路径。`packages/desktop` 退化为「开一个窗口指向 `http://127.0.0.1:4517`」。界面持有一份 `session.ts` 镜像账本，收到动作后整份重渲染，由 React 做 diff。

**Tech Stack:** React 19、Vite 8、react-markdown 10、Node 内置 http（静态文件）。

设计依据：`docs/specs/2026-09-07-phase3b1-shared-ui-design.md`

---

## 进度

| Task | 状态 |
|---|---|
| 1. Vite 能否编译 core-client（拆雷） | ✅ 通过，无需退路；安装脚本未增加 |
| 2. 协议加 list_dir | ✅ 完成，3 个测试（合计 48）|
| 3. core-server 提供静态文件与目录列表 | ✅ 完成并验证 |
| 4. React 界面：消息流与 Markdown | ✅ 完成并验证（含 HTML 注入验证）|
| 5. React 界面：工具卡片与权限确认 | ✅ 全部验证通过 |
| 6. 目录选择器 | ✅ 完成并验证（逐层进入、切换后 ls 生效）|
| 7. desktop 瘦身、删除 IPC | 未开始 |
| 8. 验收与收尾 | 未开始 |

---

## 动手前查实的事实

- **`ws` 支持挂到已有的 HTTP 服务上**：`new WebSocketServer({ server })`（来源：`node_modules/ws/lib/websocket-server.js:52-113`）。因此 WebSocket 与静态文件能共用 4517 一个端口。
- **依赖链上没有 install 类生命周期脚本**：`vite@8.2.2`、`rolldown`、`react@19.2.8`、`react-dom@19.2.8`、`react-markdown@10.1.0`、`@vitejs/plugin-react@6.1.1` 均无 `preinstall` / `install` / `postinstall`。`lightningcss` 只有 `prepare`，而 `prepare` 在「从 npm 安装依赖」时不执行。
- Vite 8 已不再依赖 esbuild（改用 rolldown），所以**不需要放行仓库里那三个未批准的安装脚本**。

## 已知风险（Task 1 专门拆）

**Vite 能不能编译 `@cinba/core-client`。** 它是指向 `packages/core-client` 的符号链接，而且内部
import 带 `.ts` 后缀（`./events.ts`）。理论上 Vite 会解析符号链接、得到 `node_modules` 之外的
真实路径，从而正常编译；但**未实测**。Task 1 用一个「Hello」页面单独验证这一件事，不掺任何界面代码。

若不通，退路按优先级：

1. `optimizeDeps.exclude: ["@cinba/core-client"]`
2. Vite 的 `resolve.alias` 直接把 `@cinba/core-client` 指到 `packages/core-client/src/index.ts`
3. 给 `core-client` 加一个构建步骤，产出 `.js` 供浏览器用（最后手段，会改变它「无构建」的性质）

## 3b-1 明确不做

远程访问、鉴权、断线重连、手机适配、模型切换、会话历史。

**服务仍只监听 `127.0.0.1`。**

---

## 文件结构

```
packages/web/                 新增包
├── package.json
├── vite.config.ts
├── index.html
└── src/
    ├── main.tsx              入口：连 WebSocket、维护镜像账本、渲染 App
    ├── Transcript.tsx        消息流：Message / ToolCard / Notice 三种条目
    ├── ProjectPicker.tsx     目录选择器
    └── style.css             从 desktop 搬过来

packages/core-client/src/
├── protocol.ts               修改：加 list_dir / dir_listing
├── protocol.test.ts          修改
├── remote.ts                 修改：加 listDir() 与 onDirListing
└── remote.test.ts            修改

packages/core-server/src/
└── index.ts                  修改：http 服务 + 静态文件 + list_dir 处理

packages/desktop/
├── package.json              修改：去掉 core-client 依赖
└── src/
    ├── main.ts               整份重写，约 25 行
    ├── preload.js            删除
    └── renderer/             删除（整个目录）
```

---

## Task 1：Vite 能否编译 core-client（拆雷）

**目的：** 在写任何界面代码之前，先确认 Vite 能把 `@cinba/core-client` 编译进浏览器包。
这是本阶段唯一的未知数，不通就要改方案。

**Files:**
- Create: `packages/web/package.json`
- Create: `packages/web/vite.config.ts`
- Create: `packages/web/index.html`
- Create: `packages/web/src/main.tsx`

- [ ] **Step 1: 创建包**

`packages/web/package.json`：

```json
{
  "name": "@cinba/web",
  "private": true,
  "type": "module",
  "version": "0.0.0",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "@cinba/core-client": "*",
    "react": "^19.2.8",
    "react-dom": "^19.2.8",
    "react-markdown": "^10.1.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^6.1.1",
    "vite": "^8.2.2"
  }
}
```

- [ ] **Step 2: 写 Vite 配置**

`packages/web/vite.config.ts`：

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // 产物用相对路径引用资源，这样 core-server 从任意前缀提供都能工作。
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173 },
});
```

- [ ] **Step 3: 写最小页面**

`packages/web/index.html`：

```html
<!doctype html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Cinba</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`packages/web/src/main.tsx`：

```tsx
// 冒烟实验：验证 Vite 能把 @cinba/core-client 编译进浏览器包。
// 这一版不连服务器、不画界面。

import { createRoot } from "react-dom/client";
import { parseClientMessage } from "@cinba/core-client";

const parsed = parseClientMessage({ type: "prompt", text: "你好" });

createRoot(document.getElementById("root")!).render(
  <div style={{ fontFamily: "system-ui", padding: "2rem" }}>
    <h1>Vite 冒烟实验</h1>
    <p>
      从 core-client 导入的 parseClientMessage 返回：
      <code>{JSON.stringify(parsed)}</code>
    </p>
    <p>看到上面那行 JSON，就说明 core-client 能编译进浏览器。</p>
  </div>,
);
```

- [ ] **Step 4: 安装，并确认安全姿态没变**

```powershell
npm install
```

**这一步有个必须确认的验收项。** 安装完成后留意 npm 的 `allow-scripts` 警告，
被拦下的应当仍是原来那三个：

```
@google/genai
esbuild
protobufjs
```

**若列表变长了，停下来告诉用户**，不要自行 `npm approve-scripts`——那是用户从阶段 1a
起就刻意保持的安全姿态。

- [ ] **Step 5: 跑起来（关键验证）**

```powershell
npm run dev --workspace @cinba/web
```

浏览器打开 `http://localhost:5173`。期望：页面显示

```
从 core-client 导入的 parseClientMessage 返回：{"type":"prompt","text":"你好"}
```

**这证明了三件事**：Vite 能解析 workspace 符号链接、能处理带 `.ts` 后缀的 import、
`core-client` 确实不含任何 Node 专属代码。

- [ ] **Step 6: 若失败，按序尝试退路**

**只在 Step 5 失败时执行。** 记录实际报错，然后：

退路 1 —— 在 `vite.config.ts` 里加：

```typescript
  optimizeDeps: { exclude: ["@cinba/core-client"] },
```

退路 2 —— 直接指到源码：

```typescript
import { fileURLToPath } from "node:url";

  resolve: {
    alias: {
      "@cinba/core-client": fileURLToPath(
        new URL("../core-client/src/index.ts", import.meta.url),
      ),
    },
  },
```

退路 3 —— 给 `core-client` 加构建步骤产出 `.js`。**这会改变它「无构建」的性质，
动手前先跟用户确认。**

- [ ] **Step 7: 验证构建产物**

```powershell
npm run build --workspace @cinba/web
```

期望：`packages/web/dist/index.html` 与 `dist/assets/*.js` 生成。用这条确认：

```powershell
Test-Path packages\web\dist\index.html
```

期望 `True`。

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat(web): Vite smoke test compiling core-client for the browser"
```

---

## Task 2：协议加 list_dir（TDD）

**Files:**
- Modify: `packages/core-client/src/protocol.ts`
- Modify: `packages/core-client/src/protocol.test.ts`
- Modify: `packages/core-client/src/remote.ts`
- Modify: `packages/core-client/src/remote.test.ts`

- [ ] **Step 1: 写失败的测试**

在 `packages/core-client/src/protocol.test.ts` 的「认得四种客户端消息」之后插入：

```typescript
test("认得 list_dir", () => {
  assert.deepEqual(parseClientMessage({ type: "list_dir", path: "C:\\Users" }), {
    type: "list_dir",
    path: "C:\\Users",
  });
});

test("list_dir 的 path 必须是非空字符串", () => {
  assert.equal(parseClientMessage({ type: "list_dir" }), undefined);
  assert.equal(parseClientMessage({ type: "list_dir", path: "" }), undefined);
  assert.equal(parseClientMessage({ type: "list_dir", path: 42 }), undefined);
});
```

- [ ] **Step 2: 运行，确认失败**

```powershell
node --test "packages/core-client/src/protocol.test.ts"
```

期望：FAIL，「认得 list_dir」那条返回了 `undefined`。

- [ ] **Step 3: 改 protocol.ts**

把 `ClientMessage` 的定义改为（末尾多一项）：

```typescript
export type ClientMessage =
  | { type: "prompt"; text: string }
  | { type: "abort" }
  | { type: "respond_confirm"; requestId: string; confirmed: boolean }
  | { type: "set_project"; cwd: string }
  | { type: "list_dir"; path: string };
```

把 `ServerMessage` 的定义改为（末尾多一项）：

```typescript
export type ServerMessage =
  | { type: "snapshot"; snapshot: Snapshot; cwd: string }
  | { type: "actions"; actions: ViewAction[] }
  | { type: "reset"; cwd: string }
  /** parent 为上一级路径；已在根目录时为 null。dirs 只含子目录名，不含文件。 */
  | { type: "dir_listing"; path: string; parent: string | null; dirs: string[] };
```

在 `parseClientMessage` 的 `switch` 里，`default` **之前**插入：

```typescript
    case "list_dir":
      if (typeof message.path !== "string" || message.path === "") return undefined;
      return { type: "list_dir", path: message.path };
```

- [ ] **Step 4: 运行，确认通过**

```powershell
node --test "packages/core-client/src/protocol.test.ts"
```

期望：6 个测试全部 pass。

- [ ] **Step 5: 写 RemoteSession 的失败测试**

在 `packages/core-client/src/remote.test.ts` 的「四种命令都按协议发出去」之后插入：

```typescript
test("listDir 按协议发出去，目录列表交给处理器", () => {
  const fake = createFakeSocket();
  const listings: unknown[] = [];

  const remote = new RemoteSession(fake.socket, {
    onDirListing: (listing) => listings.push(listing),
  });

  remote.listDir("C:\\Users");
  assert.deepEqual(JSON.parse(fake.sent[0]!), { type: "list_dir", path: "C:\\Users" });

  fake.receive({
    type: "dir_listing",
    path: "C:\\Users",
    parent: "C:\\",
    dirs: ["shenxichen", "Public"],
  });

  assert.deepEqual(listings, [
    { path: "C:\\Users", parent: "C:\\", dirs: ["shenxichen", "Public"] },
  ]);
});
```

- [ ] **Step 6: 运行，确认失败**

```powershell
node --test "packages/core-client/src/remote.test.ts"
```

期望：FAIL，`remote.listDir` 不是一个函数。

- [ ] **Step 7: 改 remote.ts**

在 `RemoteHandlers` 里加一项：

```typescript
export type RemoteHandlers = {
  onSnapshot?: (snapshot: Snapshot, cwd: string) => void;
  onActions?: (actions: ViewAction[]) => void;
  onReset?: (cwd: string) => void;
  onDirListing?: (listing: { path: string; parent: string | null; dirs: string[] }) => void;
};
```

在 `setProject` 方法后面加：

```typescript
  listDir(path: string): void {
    this.#send({ type: "list_dir", path });
  }
```

在 `#receive` 的 `switch` 里，`default` **之前**插入：

```typescript
      case "dir_listing":
        this.#handlers.onDirListing?.({
          path: message.path,
          parent: message.parent,
          dirs: message.dirs,
        });
        return;
```

- [ ] **Step 8: 跑全部测试**

```powershell
node --test "packages/core-host/src/*.test.ts" "packages/core-client/src/*.test.ts"
```

期望：48 个测试全部 pass（原 45 + 本任务的 3）。

- [ ] **Step 9: 提交**

```powershell
git add -A
git commit -m "feat(core-client): directory listing messages"
```

---

## Task 3：core-server 提供静态文件与目录列表

**Files:**
- Modify: `packages/core-server/package.json`
- Modify: `packages/core-server/src/index.ts`

`core-server` 的 `package.json` **不改**：它只是按仓库布局读取 `packages/web/dist` 里的文件，
并不 import 那个包。声明一个用不到的依赖会让「声明」与「实际」对不上，阶段 1b 清理过这类问题。

- [ ] **Step 1: 加静态文件服务**

在 `packages/core-server/src/index.ts` 的 import 区，把 `ws` 那行之后补上：

```typescript
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
```

在 `const FLUSH_INTERVAL_MS = 30;` 之后插入：

```typescript
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
    response.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end("界面还没构建。请先跑：npm run build --workspace @cinba/web");
  }
}
```

- [ ] **Step 2: 把 WebSocket 挂到 HTTP 服务上**

把这一段：

```typescript
const server = new WebSocketServer({ host: HOST, port: PORT });

server.on("listening", () => {
  console.log(`[cinba] 服务已启动 ws://${HOST}:${PORT}`);
  console.log(`[cinba] 工作目录 ${cwd}`);
});
```

替换为：

```typescript
// WebSocket 与静态文件共用一个端口：界面从这里加载，也从这里连回来。
const httpServer = createServer((request, response) => void serveStatic(request, response));
const server = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, HOST, () => {
  console.log(`[cinba] 界面 http://${HOST}:${PORT}`);
  console.log(`[cinba] 工作目录 ${cwd}`);
});
```

并把 `shutdown()` 里的 `server.close();` 改为：

```typescript
  server.close();
  httpServer.close();
```

- [ ] **Step 3: 处理 list_dir**

在 import 区的 `node:fs` 那行加上 `readdirSync`：

```typescript
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
```

在 `handle()` 的 `switch` 里，`case "set_project"` **之后**插入：

```typescript
    case "list_dir": {
      // 浏览器拿不到本地路径，所以由服务器列目录、界面只负责画。
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
```

- [ ] **Step 4: 验证静态文件与目录列表**

```powershell
node packages\core-server\src\index.ts
```

期望终端打出 `[cinba] 界面 http://127.0.0.1:4517`。

另开一个 PowerShell 窗口：

```powershell
(Invoke-WebRequest http://127.0.0.1:4517/).StatusCode
```

期望 `200`（Task 1 已经构建过 `dist`）。

再验目录列表——新建 `packages/core-server/tmp-probe.mjs`：

```javascript
const ws = new WebSocket("ws://127.0.0.1:4517");
ws.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  if (message.type === "dir_listing") {
    console.log("父目录:", message.parent);
    console.log("子目录:", message.dirs.slice(0, 8).join(", "));
    process.exit(0);
  }
};
ws.onopen = () => ws.send(JSON.stringify({ type: "list_dir", path: "C:\\Users\\shenxichen" }));
setTimeout(() => process.exit(1), 10000);
```

```powershell
node packages\core-server\tmp-probe.mjs
Remove-Item packages\core-server\tmp-probe.mjs
```

期望：打出父目录 `C:\Users` 和若干子目录名。

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "feat(core-server): serve the UI and list directories on the same port"
```

---

## Task 4：React 界面 —— 消息流与 Markdown

**Files:**
- Create: `packages/web/src/style.css`
- Modify: `packages/web/src/main.tsx`（整份替换）
- Create: `packages/web/src/Transcript.tsx`

- [ ] **Step 1: 搬样式**

把 `packages/desktop/src/renderer/style.css` 整份复制到 `packages/web/src/style.css`，
然后在末尾追加 Markdown 与目录选择器要用的样式：

```css
.entry pre {
  background: #f6f6f6;
  border-radius: 4px;
  padding: 0.6rem;
  overflow-x: auto;
  font-size: 12px;
}

.entry code { background: #f2f2f2; border-radius: 3px; padding: 0.1em 0.3em; font-size: 0.92em; }
.entry pre code { background: none; padding: 0; }
.entry h1, .entry h2, .entry h3 { margin: 0.6rem 0 0.3rem; font-size: 1.05em; }
.entry ul, .entry ol { margin: 0.3rem 0; padding-left: 1.4rem; }
.entry p { margin: 0.4rem 0; }
.entry blockquote { margin: 0.4rem 0; padding-left: 0.8rem; border-left: 3px solid #ddd; color: #666; }

.picker { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); display: flex; align-items: center; justify-content: center; }
.picker-box { background: #fff; border-radius: 10px; padding: 1rem; width: min(520px, 90vw); max-height: 70vh; display: flex; flex-direction: column; gap: 0.6rem; }
.picker-path { font-family: ui-monospace, monospace; font-size: 12px; color: #666; word-break: break-all; }
.picker-list { overflow-y: auto; border: 1px solid #eee; border-radius: 6px; }
.picker-item { display: block; width: 100%; text-align: left; border: none; border-bottom: 1px solid #f2f2f2; border-radius: 0; padding: 0.5rem 0.8rem; background: #fff; }
.picker-item:hover { background: #f6f8ff; }
.picker-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
```

- [ ] **Step 2: 写消息流组件**

`packages/web/src/Transcript.tsx`：

```tsx
// 消息流。三种条目：消息、工具卡片、系统提示。
//
// 与阶段 1b 的手写 DOM 版最大的不同：这里不做增量更新，整份从快照渲染，
// 由 React 去 diff。因此不再需要 textNodes / toolNodes 那些节点簿记。

import Markdown from "react-markdown";
import type { Entry, MessageEntry, NoticeEntry, ToolEntry } from "@cinba/core-client";

const STATUS_LABEL: Record<string, string> = {
  pending: "待批准",
  running: "执行中",
  done: "完成",
  error: "被拒绝或出错",
};

function Message({ entry }: { entry: MessageEntry }) {
  return (
    <div className={`entry ${entry.role}`}>
      <div className="role">{entry.role === "user" ? "你" : "助手"}</div>

      {entry.thinking ? (
        <details className="thinking">
          <summary>思考过程</summary>
          <pre>{entry.thinking}</pre>
        </details>
      ) : null}

      {/*
        react-markdown 默认不允许原始 HTML，且构建的是 React 节点树而不是往 DOM 里塞字符串。
        模型输出的 <script> 只会显示成文字——这正是阶段 1b 推迟 Markdown 的那个顾虑的解法。
      */}
      <Markdown>{entry.text}</Markdown>
    </div>
  );
}

function ToolCard({
  entry,
  onRespond,
}: {
  entry: ToolEntry;
  onRespond: (requestId: string, confirmed: boolean) => void;
}) {
  return (
    <div className={`tool ${entry.status}`}>
      <div className="tool-head">
        <span className="tool-name">{entry.toolName}</span>
        <span className="tool-status">{STATUS_LABEL[entry.status] ?? entry.status}</span>
      </div>

      {entry.args !== undefined ? (
        <pre className="tool-args">{JSON.stringify(entry.args, null, 2)}</pre>
      ) : null}

      {entry.result ? <pre className="tool-result">{entry.result}</pre> : null}

      {entry.confirmRequestId ? (
        <div className="tool-confirm">
          <button className="allow" onClick={() => onRespond(entry.confirmRequestId!, true)}>
            允许
          </button>
          <button className="deny" onClick={() => onRespond(entry.confirmRequestId!, false)}>
            拒绝
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function Transcript({
  entries,
  onRespond,
}: {
  entries: Entry[];
  onRespond: (requestId: string, confirmed: boolean) => void;
}) {
  return (
    <>
      {entries.map((entry, index) => {
        if (entry.kind === "message") {
          return <Message key={entry.messageId} entry={entry} />;
        }
        if (entry.kind === "tool") {
          return <ToolCard key={entry.toolCallId} entry={entry} onRespond={onRespond} />;
        }
        const notice = entry as NoticeEntry;
        // 系统提示没有天然的 id，用序号兜底——它只追加不修改，序号是稳定的。
        return (
          <div className="notice" key={`notice-${index}`}>
            {notice.text}
          </div>
        );
      })}
    </>
  );
}
```

- [ ] **Step 3: 写入口**

`packages/web/src/main.tsx` 整份替换为：

```tsx
// 界面入口：连服务器、维护镜像账本、渲染。
//
// 这份代码同时服务于浏览器与 Electron 窗口——两边加载的是同一个页面。

import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createSession, RemoteSession } from "@cinba/core-client";
import type { Session, Snapshot } from "@cinba/core-client";
import { Transcript } from "./Transcript.tsx";
import "./style.css";

const EMPTY: Snapshot = { entries: [], totalTokens: 0, totalCost: 0, busy: false };

/** 页面从哪来就连回哪去，所以浏览器与 Electron 都不用配置地址。 */
const SERVER_URL = `ws://${location.host}`;

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [cwd, setCwd] = useState("");
  const [draft, setDraft] = useState("");

  const remoteRef = useRef<RemoteSession | undefined>(undefined);
  const mirrorRef = useRef<Session>(createSession());
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const socket = new WebSocket(SERVER_URL);

    remoteRef.current = new RemoteSession(socket, {
      onSnapshot: (next, nextCwd) => {
        mirrorRef.current = createSession(next);
        setSnapshot(next);
        setCwd(nextCwd);
      },
      onActions: (actions) => {
        for (const action of actions) mirrorRef.current.apply(action);
        setSnapshot(mirrorRef.current.snapshot());
      },
      onReset: (nextCwd) => setCwd(nextCwd),
    });

    return () => socket.close();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [snapshot]);

  // Esc 中止。必须挂在 window 上，不能挂在输入框上——回答期间输入框是 disabled 的，
  // 禁用的元素收不到键盘事件。阶段 1b 的 GUI 踩过这个坑。
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && snapshot.busy) {
        event.preventDefault();
        remoteRef.current?.abort();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [snapshot.busy]);

  function send() {
    const text = draft.trim();
    if (snapshot.busy || text === "") return;
    setDraft("");
    remoteRef.current?.prompt(text);
  }

  return (
    <>
      <header>
        <button>项目：{cwd.split(/[\\/]/).pop() || "…"}</button>
        <span>
          {snapshot.totalTokens} tokens · ${snapshot.totalCost.toFixed(4)}
        </span>
      </header>

      <main id="transcript">
        <Transcript
          entries={snapshot.entries}
          onRespond={(requestId, confirmed) =>
            remoteRef.current?.respondConfirm(requestId, confirmed)
          }
        />
        <div ref={bottomRef} />
      </main>

      <footer>
        <textarea
          rows={3}
          placeholder="说点什么（Enter 发送，Shift+Enter 换行）"
          value={draft}
          disabled={snapshot.busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        <button onClick={send} disabled={snapshot.busy}>
          发送
        </button>
        {snapshot.busy ? (
          <button onClick={() => remoteRef.current?.abort()}>中止</button>
        ) : null}
      </footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
```

- [ ] **Step 4: 验证纯对话**

一个终端起服务：

```powershell
node packages\core-server\src\index.ts
```

另一个终端起开发服务器：

```powershell
npm run dev --workspace @cinba/web
```

浏览器打开 `http://localhost:5173`，问一句「用 Markdown 写一个三级标题和一个列表」。期望：

1. 消息逐字冒出来
2. **Markdown 正确渲染**（标题是标题、列表是列表，不再是字面的 `#` 和 `-`）
3. 回答期间输入框变灰
4. 费用与 token 在右上角增长

- [ ] **Step 5: 验证 HTML 不被执行（安全）**

问：「请原样输出这一行，不要解释：`<img src=x onerror="alert(1)">`」

期望：**页面上显示为文字**，没有弹窗、没有破图。这验证了 `react-markdown` 默认禁原始 HTML。

- [ ] **Step 6: 提交**

```powershell
git add -A
git commit -m "feat(web): React transcript with Markdown rendering"
```

---

## Task 5：工具卡片与权限确认

Task 4 里 `Transcript.tsx` 已经把工具卡片与确认按钮写完了，本任务只做验证。

- [ ] **Step 1: 验证放行**

浏览器里问「运行 ls 命令，告诉我当前目录下有什么」。期望：

1. 出现橙色左边框的卡片，写着 `bash`「待批准」，下面是命令参数
2. 卡片上有「允许」「拒绝」两个按钮，界面停在这里等
3. 点「允许」→ 转蓝「执行中」→ 转绿「完成」并显示输出
4. 助手接着回答

- [ ] **Step 2: 验证拦截**

再问一次，这次点「拒绝」。期望：卡片转红、结果区显示「用户拒绝了这次工具调用」、
**助手明确表示知道被拒绝了**。

- [ ] **Step 3: 验证中止与刷新**

- [ ] 问一个长问题，输出到一半按 `Esc` 或点「中止」→ 出现「已中止」胶囊
- [ ] **按 F5 刷新浏览器 → 对话完整恢复**（账本在服务器，浏览器重连拿快照）

- [ ] **Step 4: 若有问题则修，无问题跳过提交**

```powershell
git add -A
git commit -m "fix(web): tool card corrections"
```

---

## Task 6：目录选择器

**Files:**
- Create: `packages/web/src/ProjectPicker.tsx`
- Modify: `packages/web/src/main.tsx`

- [ ] **Step 1: 写选择器**

`packages/web/src/ProjectPicker.tsx`：

```tsx
// 目录选择器。
//
// 浏览器拿不到本地路径（那是刻意的安全限制），所以由服务器列目录、这里只负责画。
// 桌面版与网页版共用这一套——3b-2 远程接入时同样成立。

import { useEffect, useState } from "react";
import type { RemoteSession } from "@cinba/core-client";

export type Listing = { path: string; parent: string | null; dirs: string[] };

export function ProjectPicker({
  remote,
  listing,
  startPath,
  onClose,
}: {
  remote: RemoteSession | undefined;
  listing: Listing | undefined;
  startPath: string;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState(startPath);

  useEffect(() => {
    remote?.listDir(startPath);
  }, [remote, startPath]);

  function go(path: string) {
    setCurrent(path);
    remote?.listDir(path);
  }

  const shown = listing?.path === current ? listing : undefined;

  return (
    <div className="picker" onClick={onClose}>
      <div className="picker-box" onClick={(event) => event.stopPropagation()}>
        <div className="picker-path">{current}</div>

        <div className="picker-list">
          {shown?.parent ? (
            <button className="picker-item" onClick={() => go(shown.parent!)}>
              .. 上一级
            </button>
          ) : null}
          {shown?.dirs.map((name) => (
            <button
              className="picker-item"
              key={name}
              onClick={() => go(`${current}${current.endsWith("\\") ? "" : "\\"}${name}`)}
            >
              {name}
            </button>
          ))}
          {shown && shown.dirs.length === 0 ? (
            <div className="picker-item">（没有子目录）</div>
          ) : null}
        </div>

        <div className="picker-actions">
          <button onClick={onClose}>取消</button>
          <button
            onClick={() => {
              remote?.setProject(current);
              onClose();
            }}
          >
            就用这个目录
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 接进入口**

在 `packages/web/src/main.tsx` 的 import 区加：

```tsx
import { ProjectPicker } from "./ProjectPicker.tsx";
import type { Listing } from "./ProjectPicker.tsx";
```

在 `const [draft, setDraft] = useState("");` 之后加两个状态：

```tsx
  const [picking, setPicking] = useState(false);
  const [listing, setListing] = useState<Listing | undefined>(undefined);
```

在 `RemoteSession` 的处理器里加一项（`onReset` 之后）：

```tsx
      onDirListing: (next) => setListing(next),
```

把 header 里那个按钮改成能点：

```tsx
        <button onClick={() => setPicking(true)}>项目：{cwd.split(/[\\/]/).pop() || "…"}</button>
```

在最外层 `</footer>` **之后**插入：

```tsx
      {picking ? (
        <ProjectPicker
          remote={remoteRef.current}
          listing={listing}
          startPath={cwd}
          onClose={() => setPicking(false)}
        />
      ) : null}
```

- [ ] **Step 3: 验证**

浏览器里点左上角「项目：…」按钮。期望：

1. 弹出一个浮层，显示当前目录路径与子目录列表
2. 点子目录能进去，点「.. 上一级」能退回
3. 点「就用这个目录」→ 浮层关闭，对话清空，左上角显示新目录名
4. 问「运行 ls」，列出的是**新目录**的内容

- [ ] **Step 4: 提交**

```powershell
git add -A
git commit -m "feat(web): directory picker over server-provided listings"
```

---

## Task 7：desktop 瘦身，删除 IPC

**Files:**
- Modify: `packages/desktop/package.json`
- Modify: `packages/desktop/src/main.ts`（整份重写）
- Delete: `packages/desktop/src/preload.js`
- Delete: `packages/desktop/src/renderer/`（整个目录）

- [ ] **Step 1: 重写 main.ts**

```typescript
// Electron 主进程。
//
// 3b-1 之后它只做一件事：开一个窗口，指向 core-server 提供的界面。
// 界面代码与浏览器版完全相同，连服务器也走同一条 WebSocket——
// 因此这里不再需要 preload、IPC，或任何对协议的了解。

import { app, BrowserWindow } from "electron";

const UI_URL = "http://127.0.0.1:4517/";

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 980,
    height: 760,
    title: "Cinba",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  void window.loadURL(UI_URL);
});

app.on("window-all-closed", () => app.quit());
```

- [ ] **Step 2: 删掉不再需要的文件**

```powershell
Remove-Item packages\desktop\src\preload.js
Remove-Item -Recurse packages\desktop\src\renderer
```

- [ ] **Step 3: 去掉运行时依赖**

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
  "devDependencies": {
    "electron": "^44.2.0"
  }
}
```

- [ ] **Step 4: 验证 Electron 窗口显示同一个界面**

先构建界面：

```powershell
npm run build --workspace @cinba/web
```

起服务：

```powershell
node packages\core-server\src\index.ts
```

起 Electron：

```powershell
npm start --workspace @cinba/desktop
```

期望：窗口里显示的界面**与浏览器里完全一样**，能对话、能批准工具、能切换项目。

- [ ] **Step 5: 验证两边同时开着**

保持 Electron 窗口开着，浏览器再打开 `http://127.0.0.1:4517`。

在其中一边发消息，期望**另一边同步显示**。

- [ ] **Step 6: 提交**

```powershell
git add -A
git commit -m "refactor(desktop): reduce to a window pointing at the shared UI"
```

---

## Task 8：验收与收尾

- [ ] **Step 1: 跑全部测试**

```powershell
node --test "packages/core-host/src/*.test.ts" "packages/core-client/src/*.test.ts"
```

期望：48 个全部 pass。

- [ ] **Step 2: 确认安全姿态没变**

```powershell
npm install
```

期望：被拦下的安装脚本仍是 `@google/genai`、`esbuild`、`protobufjs` 三个，没有变多。

- [ ] **Step 3: 确认 TUI 未受影响**

```powershell
node packages\tui\src\index.ts
```

问一句话、试一次权限确认、Ctrl+C 退出。

- [ ] **Step 4: 走完整验收清单**

- [ ] 浏览器打开 `http://127.0.0.1:4517`，功能与 3a 的 GUI 完全一致
- [ ] Electron 窗口显示同一个界面
- [ ] 两边同时开着，看到同一个会话，任一边发消息另一边同步
- [ ] Markdown 正确渲染（标题、列表、代码块、粗体）
- [ ] 让模型输出一段 HTML，确认显示为文字而非被执行
- [ ] 目录选择器能逐层进入并切换项目
- [ ] 中止、权限确认、thinking 折叠、费用显示全部照旧
- [ ] `preload.js` 与 `renderer/` 已从仓库删除
- [ ] `npm install` 后被拦下的安装脚本仍是原来那三个
- [ ] Ctrl+C 停掉 core-server 后无残留 node 进程

- [ ] **Step 5: 更新文档并提交**

把本文件进度表标为完成，勾上设计文档第 9 节的清单。

```powershell
git add -A
git commit -m "docs: mark phase 3b-1 complete"
```

---

## 阶段 3b-1 完成标准

- [ ] Task 8 Step 4 的十项验收全部通过
- [ ] `node --test` 48 个全绿
- [ ] `packages/desktop` 不含任何界面代码，`main.ts` 在 30 行以内
- [ ] 被拦下的安装脚本仍是原来那三个
- [ ] 服务仍只监听 `127.0.0.1`

达成后进 3b-2：远程接入（Tailscale、令牌、断线重连、手机适配）。
