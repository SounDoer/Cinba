# Cinba 设计文档

日期：2026-09-06
状态：已确认，待实施

## 1. 目标

做一个属于自己的 AI 编码助手客户端，同时具备桌面 GUI 和终端 TUI 两种形态，后续扩展到网页版。

两个核心动机：

1. **模型/厂商自由** —— 不被锁定在某一家的订阅上，能自由切换模型、用自己的 API key 或本地模型。
2. **搞懂 agent 的工作原理** —— 通过亲手搭建来真正理解 agent 循环、工具调用、上下文管理是怎么回事。

这两个动机决定了项目的性质：**这不是一个领域定制工具，而是一个自己掌控的通用客户端 + 一次深入学习**。因此路线安排以"每一步都学得明白"优先，不以最快出成品优先。

## 2. 非目标

明确不做的事，写下来是为了防止范围蔓延：

- 不做特定领域的工作流定制（音频、Reaper/Wwise 等）。将来想加，走 extensions，不影响架构。
- 不 fork Pi。Pi 作为 npm 依赖使用，所有个性化通过 extensions 和启动配置实现。
- 不做多用户、鉴权、团队协作。单人自用。
- 阶段 1-2 不做打包分发、自动更新、CI。

## 3. 架构

三层，边界严格：

```
┌─ 前端层 ─────────────────────────────────────────┐
│  Electron GUI (本机)  │  TUI (服务器)  │  [阶段3] Web │
└────────────────────┬─────────────────────────────┘
                     │  只认协议，永不 import Pi
┌─ 协议层 ───────────▼─────────────────────────────┐
│  core-client：收发 JSONL、把原始事件变成类型化事件    │
│  传输：stdio 管道（阶段0-2）→ WebSocket（阶段3）     │
└────────────────────┬─────────────────────────────┘
┌─ 核心层 ───────────▼─────────────────────────────┐
│  Pi（npm 依赖）+ 自己的 extensions                  │
│  由 core-host 负责启动与配置                        │
└──────────────────────────────────────────────────┘
```

一次完整对话的数据流：

```
用户输入 → 前端 → core-client（编码成 JSON）→ 管道 → Pi 核心
                                                      ↓ 思考、调工具
前端渲染 ← core-client（解码成类型化事件）← 管道 ← Pi 核心
```

把前端从 desktop 换成 tui，中间层和核心层不需要任何改动。这是整个设计要达成的效果。

## 4. 目录结构

以下是**阶段 2 完成时**的完整形态。阶段 0 的实际仓库只有 `package.json` 和 `scripts/probe.ts` 两个文件，其余包按阶段逐步建立，不提前占位。

```
Cinba/
├── package.json                 # workspaces 声明
├── tsconfig.base.json
├── .gitignore
├── AGENTS.md                    # 项目说明，Pi 自动加载为上下文
├── docs/
│   ├── specs/                   # 设计文档
│   ├── plans/                   # 各阶段实施计划
│   └── notes/                   # 实测记录与调查笔记
├── scripts/
│   └── probe.ts                 # 阶段0 协议探针，之后留作调试工具
└── packages/
    ├── core-host/               # 「我的核心」的定义
    │   ├── package.json
    │   └── src/index.ts         #   startCore()：启动 Pi、指定模型、挂载 extensions
    │
    ├── core-client/             # 协议层
    │   ├── package.json
    │   └── src/
    │       ├── index.ts         #   对外 API：sendMessage() / onEvent()
    │       ├── transport.ts     #   传输实现。阶段3 换 WebSocket 时只动这里
    │       └── events.ts        #   原始 JSON → 类型化事件
    │
    ├── extensions/              # Pi 扩展（自定义工具、权限门、上下文注入）
    │   ├── package.json
    │   └── src/index.ts         #   初期为空，按需添加
    │
    ├── desktop/                 # Electron GUI
    │   ├── package.json
    │   └── src/
    │       ├── main.ts          #   主进程
    │       ├── preload.ts       #   安全桥（contextIsolation）
    │       └── renderer/        #   界面
    │
    └── tui/                     # 终端界面
        ├── package.json
        └── src/index.ts         #   基于 pi-tui
```

## 5. 依赖规则

这是本设计**唯一真正硬性**的约束：

```
前端 ──► core-client ──(协议)──► core-host ──► Pi + extensions
```

- `desktop` / `tui` / `web` 只依赖 `core-client`
- 前端不依赖 `extensions`，不依赖 Pi
- 依赖方向单向，不允许反向或抄近路

守住这条，加一个新前端只是加一个包；破了这条，会长出三份互相不一致的 agent。

**特别警告**：Electron 主进程自带 Node 运行时，可以直接 `import` Pi 跑在同进程里。不要这样做，否则阶段 3 的远程化会全部作废。

## 6. 关键决策与理由

| 决策 | 理由 |
|---|---|
| 核心用 Pi，不 fork | 两个动机都不需要改 Pi 源码；fork 要自扛上游更新 |
| GUI 用 Electron 而非 Tauri | Pi 核心是 Node，Electron 主进程自带 Node 运行时，拉起子进程天然顺畅；Tauri 需塞 Node sidecar，自找麻烦。已有的 Tauri 前端经验（Web 技术栈）可平移 |
| 从第一天就走进程边界 + 协议 | 阶段 3 远程化的前提；同时所有事件变成可读 JSON，正好服务于"搞懂原理" |
| TUI 自己写，不用 Pi 原生 CLI | 保证两端共用同一套核心定义与协议层；`pi-tui` 已提供 Editor、Markdown、SelectList，最难的部分不用自己造 |
| `core-host` 单独成包 | 保证"我的 agent"只有一处定义，避免 GUI 和 TUI 逐渐分化 |

## 7. 路线

```
阶段0  协议探针      —— 看懂 Pi 到底吐什么
阶段1  Electron GUI  —— 主力阶段，日常替代 Codex
阶段2  TUI           —— 极简版，服务器上够用即可
阶段3  换 WebSocket  —— 核心跑服务器，两端远程连接 + Web 前端
阶段4  UI 打磨       —— 模型切换、会话树、权限确认面板等
```

**阶段 0 交付物**：`scripts/probe.ts`，几十行。spawn Pi 的 RPC 模式，把所有 JSONL 事件原样打印。仓库此时只有 `package.json` 和这一个文件。

**阶段 2 刻意做朴素**：一个输入框、一条消息流、Ctrl+C 退出。不做模型选择器、不做会话浏览器——服务器上要的是能用，不是好看。那些留到阶段 4。

**阶段 3 才会变贵的部分**（阶段 1-2 不提前做，但心里有数）：会话存储从本地文件变共享存储；工具权限确认从同步弹窗变异步网络往返。只要前两阶段不假设"核心与 UI 同进程、同机器、同文件系统"，这些都是加东西而非推倒重来。

## 8. 已验证的结论与待解问题

完整实测记录见 `docs/notes/2026-09-06-rpc-protocol-findings.md`。

### 已确认（阶段 0 实测，2026-09-06）

- **走 RPC 模式**（`pi --mode rpc`）。事件流完整可用：`agent_start` / `turn_start` / `message_start` / `message_update` / `tool_execution_*` / `agent_end` / `agent_settled`，嵌套结构为 agent > turn > message。
- **`agent_settled` 是"可接受新输入"的信号**，GUI 据此解除输入锁。不可用 `turn_end` 代替——调完工具后还会有下一轮。
- **RPC 进程常驻**，一次 prompt 结束后不退出。`core-host` 需管理进程生命周期，GUI 关闭时必须回收子进程。
- **消息的 role 有三种**：`user` / `assistant` / `toolResult`。
- **费用与 token 用量随消息实时返回**，GUI 无需自行计算。

### ⚠️ 已确认的安全缺口

**RPC 模式默认放行模型请求的一切工具调用，没有权限确认握手。** `tool_execution_start` 之后直接执行，不等待客户端回应。

因此**权限门是阶段 1 的硬需求**，不是可选项：`packages/extensions/` 中第一个要实现的就是它（`pi.on("tool_call")` 拦截 + `ctx.ui.confirm()`）。在此之前不得在含重要文件的目录中运行，也不得用可能触发写操作的 prompt。

### 待解问题

- **`ctx.ui.confirm()` 如何穿过 RPC 边界。** 权限确认的对话框在 GUI 侧，拦截逻辑在核心侧的 extension 里，中间隔着协议。需查明 Pi 的 extension UI protocol 是否已为 RPC 模式定义了对应的往返事件；若没有，需要自己设计这条通道。**这是阶段 1 最硬的一块，动手前必须先查清。**
- **`shell: true` 的替代方案。** 当前 spawn Pi 依赖 shell（Windows 上 Node 禁止直接 spawn `.cmd`），会触发 DEP0190 警告。`core-host` 正式实现时应改为直接用 Node 启动 Pi 的入口 JS，绕开 shell。
- **Pi 的 extension API 稳定性。** 文档路径带 `/latest`，项目迭代快。因此不把大量逻辑压在 extension API 上。

## 9. 安全注意

- Pi 的 extensions 以完整系统权限运行，引入第三方 Pi package 前必须审阅代码。
- Electron 侧：`contextIsolation` 开启，`nodeIntegration` 关闭，渲染进程与主进程一律走 IPC。

## 10. 命名

项目名 Cinba。npm 上 `cinba` 与 `@cinba` scope 均未被占用（2026-09-06 核实）。包命名为 `@cinba/core-host`、`@cinba/core-client` 等。
