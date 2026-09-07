# Cinba 设计文档

日期：2026-09-06（最后更新 2026-09-07）
状态：阶段 0 / 1a / 1b / 2 / 3a / 3b-1 已完成，阶段 3b-2 待开始。第 8 节记录了各阶段实测确认与新暴露的问题。

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
| 权限门由 `core-host` 无条件挂载 | 它是 agent 的固有属性而非界面功能。交给调用方传，就意味着某个调用方忘了传就会裸奔 |

## 7. 路线

```
阶段0  协议探针      —— 看懂 Pi 到底吐什么
阶段1  Electron GUI  —— 主力阶段，日常替代 Codex
阶段2  TUI           —— 极简版，服务器上够用即可
阶段3  远程接入      —— 核心留在本机，增加远程入口 + Web 前端（2026-09-07 调整，见下）
阶段4  UI 打磨       —— 模型切换、会话树、权限确认面板等
```

**阶段 0 交付物**：`scripts/probe.ts`，几十行。spawn Pi 的 RPC 模式，把所有 JSONL 事件原样打印。仓库此时只有 `package.json` 和这一个文件。

**阶段 2 刻意做朴素**：一个输入框、一条消息流、Ctrl+C 退出。不做模型选择器、不做会话浏览器——服务器上要的是能用，不是好看。那些留到阶段 4。

**阶段 4 可能同时引入构建步骤**：GUI 侧现在是手写 DOM、无框架，TUI 侧用 pi-tui。打磨期两边都可能想换——GUI 换成前端框架，TUI 换成 Ink（终端里的 React，Claude Code 与 Codex 都在用）。届时理由会比现在充分：需要构建步骤的地方不止一处，且对两个界面都已有实感。现在不做，是因为为了单个界面库去改整个仓库「不编译」的性质，代价与收益不成比例。换界面层的成本始终很低——它是整个系统里最容易推倒重写的一层。

**阶段 3 的形态已调整（2026-09-07）。** 原计划是「核心搬到服务器」，讨论后改为
「**核心留在本机，增加远程入口**」，理由是本机 GUI/TUI 是日常主力场景，不应为了远程而变复杂。

```
原计划（形态 A）        本机界面 ←网络→ 服务器上的核心      本机用法也要走网络
现计划（形态 B）        本机界面 ←管道→ 本机核心 ←网络→ 手机/网页
```

形态 B 也是通往形态 A 的必经之路：WebSocket 传输层、网络桥接、断线处理、跨网络的权限确认，
两者都要。将来若要搬到服务器，做的是「把跑通的东西挪个位置」，而那次挪动恰好就是第 8 节
记录的「把 `desktop` 拆成薄前端 + 独立核心进程」。

**形态 A 暂缓，不是否决。** 触发重新讨论的信号是：本机电脑休眠导致连不上这件事开始频繁困扰
使用——那时再换是有依据的决定，而不是拍脑袋。

**服务器场景不为它做额外工作**：SSH + TUI 已经够用，且安全性由 SSH 负责，比自己写的鉴权可靠。

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

### 已解决（阶段 3a）

- ~~**`desktop` 包同时扮演了前端与核心侧。**~~ 3a 把 Pi 与账本搬进独立的 `core-server` 进程，
  `desktop` 改为通过 WebSocket 连接它，依赖只剩 `@cinba/core-client`——第 5 节的依赖规则
  回到设计原样。选的是「薄前端 + 独立核心进程」那条路。

### 已解决（阶段 1 期间）

- ~~**`ctx.ui.confirm()` 如何穿过 RPC 边界。**~~ Pi 的 extension UI protocol 已经定义好了这条往返通道（`extension_ui_request` / `extension_ui_response`，按 `id` 配对），不需要自造。但 Pi 内置的 `RpcClient` 用不了——它的 `send()` 是 private，没法把回应写回 stdin，所以 `core-client` 自己实现。详见 `docs/notes/2026-09-06-rpc-protocol-findings.md` 第 9 节。
- ~~**`shell: true` 的替代方案。**~~ 改为用 Node 直接执行 Pi 的 `rpc-entry`，两个问题都没了。**但在 Electron 下有个陷阱**：主进程里 `process.execPath` 是 `electron.exe` 而不是 `node.exe`，必须给子进程设 `ELECTRON_RUN_AS_NODE=1`，否则 Electron 会把入口文件当成一个 app 加载后静默退出。已在 `core-host` 落实并加测试。

### 待解问题

- **Pi 的 extension API 稳定性。** 文档路径带 `/latest`，项目迭代快。因此不把大量逻辑压在 extension API 上。**升级 Pi 后的重验步骤见第 9 节。**

- ~~**⚠️ 切换项目这条路假设了核心与界面共享文件系统。**~~ **阶段 3b-1 已解决**：
  改为服务器列目录、界面只负责画，浏览器与桌面共用一套，远程时同样成立。以下为原记录。

- **（已解决，存档）切换项目这条路曾假设核心与界面共享文件系统。** 第 7 节明确警告过「前两阶段不要假设核心与 UI 同进程、同机器、同文件系统」，**而这一条我们踩了**：

  ```js
  // packages/desktop/src/main.ts
  dialog.showOpenDialog(window, { properties: ["openDirectory"] })  // 弹的是本机的选择器
  existsSync(parsed.cwd)                                            // 查的是本机的路径
  ```

  阶段 3 里项目目录在服务器上，本机选择器选不到，`existsSync` 查错了机器。**这条是必须重做，不是可选优化。**

  影响范围已核实：只在 `main.ts` 的 `chooseProject` / `loadCwd` / `saveCwd` 三处，约 40 行。渲染层拿到的「项目」只是一个用来显示名字的字符串，从不碰路径，所以不受影响。重做时应改为向核心侧索取可选目录，而不是在界面这侧翻文件系统。

## 9. 安全注意

- Pi 的 extensions 以完整系统权限运行，引入第三方 Pi package 前必须审阅代码。
- Electron 侧：`contextIsolation` 开启，`nodeIntegration` 关闭，`sandbox` 开启。
  **阶段 3b-1 之后不再有 IPC**——窗口加载的是 core-server 提供的网页，与浏览器走完全相同的
  路径（WebSocket 连 `127.0.0.1:4517`）。`preload.js` 已删除，Electron 主进程只负责开窗口。
- 模型输出经 `react-markdown` 渲染，它构建 React 节点树且默认禁止原始 HTML，
  因此模型无法往界面注入标记。**不要改用 `dangerouslySetInnerHTML` 或引入 `rehype-raw`。**

### ⚠️ 升级 Pi 之后必须重验权限门

权限门是本项目**唯一**的安全设施，而它建立在 Pi 提供的三个接口上——
`pi.on("tool_call")`、`ctx.ui.confirm()`、返回 `{ block: true }`。这些都不受我们控制。

**危险在于它可能安静地失灵。** 两种失效方式：

| 失效方式 | 后果 |
|---|---|
| 接口没了，扩展加载报错 | 吵闹的失败：Pi 起不来，立刻会发现 |
| 事件改名，或 `{ block: true }` 不再被尊重 | **安静的失败**：界面照样弹确认，你点了拒绝，但命令已经执行了 |

第二种不会有任何报错。因此**每次升级 Pi 之后必须手工重验一次拒绝路径**：

```bash
node scripts/repl.ts "运行 ls 命令，告诉我当前目录下有什么"
# 出现确认提示时答 n
```

必须同时看到这两件事：

1. **命令没有执行**（`tool_execution_end` 的 `isError` 为 true，结果是「用户拒绝了这次工具调用」）
2. **模型知道自己被拒了**（回答里明确提到被拒绝，而不是假装执行成功）

用 `repl.ts` 而不是 GUI/TUI，是因为它是纯 Node 的，不用起服务器和界面，一分钟能跑完。

**为什么不做成自动化测试：** 要真正验证拦截，就得启动 Pi 并让模型真的去调用工具——慢，而且每跑一次都要花钱。这件事发生的频率（几个月一次）配一份检查单更合适。

### 当前的防御

- **扩展写得极小**：权限门 23 行，只用了三个 Pi 接口。压在 extension API 上的逻辑越少，被上游改动波及的面越小。
- **版本锁死**：`package.json` 写的是 `^0.85.1`，对 `0.x` 版本而言不跨小版本；`package-lock.json` 进一步精确锁定。**不主动升级就不会变。**

## 10. 命名

项目名 Cinba。npm 上 `cinba` 与 `@cinba` scope 均未被占用（2026-09-06 核实）。包命名为 `@cinba/core-host`、`@cinba/core-client` 等。
