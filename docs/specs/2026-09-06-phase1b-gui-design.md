# 阶段 1b：Electron GUI 设计

日期：2026-09-06
状态：已确认，待实施
前置：阶段 1a 已完成（`core-host` / `core-client` / 权限门 / `scripts/repl.ts` 全部验证通过）

## 1. 目标

把 `scripts/repl.ts` 那条已验证的链路搬进图形窗口，成为日常可用的主力客户端。

界面外观参考 Claude / Codex 的标准聊天布局，不做视觉设计投入——阶段 4 才是 UI 打磨期。

## 2. 范围

**做：**

- 单窗口、单会话
- 消息流，渲染三类 role：`user` / `assistant` / `toolResult`
- 输入框；运行期间锁定，`agent_settled` 后解锁
- 中止按钮（运行期间可见，发 `abort` 命令）
- 工具调用卡片，四种状态：待批准 / 执行中 / 完成 / 被拒
- 权限确认：直接在工具卡片上出现「允许 / 拒绝」两个按钮
- 费用与 token 用量实时显示（数据随消息返回，不自行计算）
- `thinking` 内容折叠显示，默认收起
- 切换工作目录（决定「当前是哪个项目」），记住上次选择
- 关窗口时回收 Pi 子进程

**不做**（留给阶段 4）：模型切换器、会话历史浏览、会话分叉、多窗口、打包分发。

**不做**（留给阶段 4）：会话持久化与恢复。本阶段**关掉应用**即丢失对话。

注意与 3.2 节区分：**刷新界面**（Ctrl+R）不丢对话——账本在主进程，刷新后重新索取快照即可恢复。丢失的只有关闭整个应用的情况，因为那会连同主进程一起结束。

## 3. 架构

### 3.1 进程与依赖

```
┌─ 渲染进程（Chromium）────────────────────────┐
│  index.html + renderer.js                    │
│  纯 DOM，无框架、无打包器                      │
│  不 import 任何本地包，不碰 Node               │
└──────────────┬───────────────────────────────┘
               │ IPC（preload 暴露的窄接口）
┌─ 主进程（Node 24）───────────────────────────┐
│  @cinba/core-host    起 Pi 子进程             │
│  @cinba/core-client  协议 + 折叠 + 账本        │
└──────────────┬───────────────────────────────┘
               │ stdio JSONL
        ┌──────▼──────┐
        │  Pi 子进程   │ + permission-gate extension
        └─────────────┘
```

依赖方向遵守设计文档第 5 节的硬约束：`desktop` 只依赖 `core-client` 与 `core-host`，绝不 import Pi。

### 3.2 状态归属

**唯一真相在主进程侧的 `core-client`，渲染层只持有一份可随时重建的副本。**

这条来自 VS Code webview 的官方指导（webview 无状态，状态归 extension host）与 Electron 的通行实践。直接收益：开发期间刷新界面不丢对话。

```
core-client 会话状态（消息数组）  ← 唯一真相
      ├─ 增量动作 ──→ 渲染层    平时
      └─ 完整快照 ──→ 渲染层    渲染层启动/刷新时主动索取
```

### 3.3 新增的两层

`core-client` 增加两个纯函数模块，都不依赖 Electron，都可用 `node --test` 覆盖：

**`events.ts` —— 拆信封**

把 Pi 的原始事件折叠成一小组界面动作。原始事件外层是信封，真正有用的在内层：

```json
{ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": "好" } }
```

界面动作（`ViewAction`）共七种：

| 动作 | 载荷 | 来源 |
|---|---|---|
| `message_added` | messageId、role | `message_start`（role 为 user/assistant） |
| `text_appended` | messageId、text | `message_update` 的 `text_delta` |
| `thinking_appended` | messageId、text | `message_update` 的 `thinking_delta` |
| `tool_changed` | toolCallId、toolName、args、status、result | `tool_execution_start` / `_end`，以及主进程在用户点「允许」后补发的 running |
| `confirm_requested` | requestId | `extension_ui_request`（method=confirm） |
| `usage_changed` | totalTokens、totalCost | `message_end` 的 usage，累加 |
| `busy_changed` | busy | 主进程发出 prompt 时为 true，`agent_settled` 时为 false |

工具卡片按 `toolCallId` 索引——阶段 0 笔记已确认这是并发时对号入座的依据。

**`session.ts` —— 记账本**

吃 `ViewAction`，维护消息列表，能吐出完整快照。纯函数，与传输和界面均无关。

### 3.4 IPC 契约

`preload.js` 通过 `contextBridge` 暴露的全部接口，仅此八项：

```js
window.cinba = {
  prompt(text),                  // 发一句话
  abort(),                       // 中止
  respondConfirm(requestId, ok), // 回应权限确认
  chooseProject(),               // 打开文件夹选择器，切换工作目录
  getProject(),                  // 问当前工作目录（启动时给按钮填字）
  getSnapshot(),                 // 索取完整快照
  onActions(handler),            // 订阅界面动作（成批到达）
  onReset(handler),              // 工作目录换了，该整份重画
}
```

每多一个口子就是多一份攻击面，因此只开必需的。

主进程把渲染层来的请求当作不可信输入处理：校验类型与取值范围。

### 3.5 节流

`text_delta` 逐 token 到达。主进程攒约 30ms 发一批 `text_appended`，避免每个 token 一次 IPC 往返加一次重绘。这是 Electron 侧流式 UI 的通行做法。

### 3.6 待批准状态的渲染纪律

阶段 0 实测结论：`tool_execution_start` 表示「开始处理」，**不表示已执行**。事件顺序是
`tool_execution_start` → `extension_ui_request` → （等待用户）→ `tool_execution_end`。

因此工具卡片收到 `tool_execution_start` 只能显示「待批准」，最终状态以 `tool_execution_end` 的 `isError` 为准。渲染成「已执行」会给用户错误的安全感。

## 4. 安全

沿用设计文档第 9 节，并补充：

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`
- 渲染层不加载任何远程资源；设置 CSP
- 助手输出以 `textContent` 写入 DOM，不用 `innerHTML`（本阶段不渲染 Markdown，阶段 4 再说）
- 权限门保持默认严格：只读工具自动放行，写文件与执行命令一律询问

## 5. 技术风险与备用方案

**Electron 主进程能否直接执行 `.ts`。** Electron 44 自带 Node 24.20.0，类型剥离在 Node 24 是正式功能，因此很可能可行——但**未实测**，且 Electron 对 Node 的模块加载有自己的补丁。

实施计划第一步即为验证此事。若不可行，备用方案按优先级：

1. 用 `NODE_OPTIONS=--experimental-strip-types` 启动 Electron
2. 主进程与 preload 改写为 `.js`（这两处代码很薄），`core-client` / `core-host` 仍为 `.ts`，若它们也无法被加载则退到方案 3
3. 引入最小构建步骤（需放行 esbuild 安装脚本，是本阶段唯一会改变既有安全姿态的选项）

**实测结论（2026-09-06）：** Electron 主进程可直接执行 `.ts`，并能解析本地 workspace 包
（`[smoke] startCore 是 function`）。**无需任何备用方案**，构建步骤与 esbuild 放行均不涉及。

**另一处与预期不同：** Electron 44 已**没有 `postinstall` 脚本**，改为暴露 `install-electron`
命令要求显式触发下载。因此 `npm install` 之后二进制并不存在（`node_modules/electron/dist/` 缺失、
`path.txt` 为空），需另跑一次 `node node_modules/electron/install.js`。这与安装脚本拦截无关。

## 6. 测试策略

| 层 | 手段 |
|---|---|
| `events.ts` | `node --test`，喂原始事件断言产出的动作 |
| `session.ts` | `node --test`，喂动作断言快照 |
| 主进程 / 渲染层 | 手工验收清单 |
| 全链路回归 | `scripts/repl.ts` 保留，它与 GUI 共用同一套核心 |

手工验收清单：

- [ ] 纯对话能问能答，回答期间输入框锁定，结束后解锁
- [ ] 触发 bash 时出现待批准卡片，点「允许」执行、点「拒绝」不执行且模型知道被拒
- [ ] 中止按钮能打断进行中的回答
- [ ] 费用与 token 数随对话增长
- [ ] thinking 默认收起，可展开
- [ ] 切换工作目录后 Pi 子进程重启，新会话生效
- [ ] 刷新界面（Ctrl+R）后对话内容完整恢复
- [ ] 关窗口后任务管理器中无残留 node 进程

## 7. 文件结构

```
packages/
├── core-client/src/
│   ├── events.ts          新增：原始事件 → ViewAction
│   ├── events.test.ts     新增
│   ├── session.ts         新增：ViewAction → 消息列表 + 快照
│   ├── session.test.ts    新增
│   └── index.ts           修改：导出上述两项
└── desktop/               新增包
    ├── package.json
    └── src/
        ├── main.ts        主进程：起 Pi、转发动作、处理 IPC
        ├── preload.js     安全桥
        └── renderer/
            ├── index.html
            ├── style.css
            └── renderer.js
```

## 8. 完成标准

第 6 节手工验收清单全部通过，且 `node --test "packages/core-client/src/*.test.ts"` 全绿。

达成后进阶段 2（TUI）。届时 `events.ts` 与 `session.ts` 可原样复用——这正是把它们放在 `core-client` 而非 Electron 主进程的原因。
