# RPC 协议实测发现

日期：2026-09-06
环境：Pi 0.85.1 / Node 24.19.0 / Windows 11 / provider=deepseek, model=deepseek-v4-pro

方法：`scripts/probe.ts` spawn `pi --mode rpc --provider deepseek`，向 stdin 写一条 prompt，逐条打印 stdout 的 JSONL 事件。

---

## 1. 观察到的事件类型

### 会话骨架

| 事件 | 说明 |
|---|---|
| `response` | 对我们发出的命令的确认回执，形如 `{type,command,success}` |
| `agent_start` | agent 开始运行 |
| `turn_start` / `turn_end` | 一轮的边界。一次 agent 运行可含多轮 |
| `message_start` / `message_end` | 一条消息的边界 |
| `message_update` | 助手消息的流式增量 |
| `agent_end` | agent 结束，附完整消息历史 |
| `agent_settled` | 尘埃落定，可接受下一次输入 |

### 工具调用

| 事件 | 关键字段 |
|---|---|
| `tool_execution_start` | `toolCallId`、`toolName`、`args` |
| `tool_execution_update` | 同上 + `partialResult`（输出流式回传） |
| `tool_execution_end` | `toolCallId`、`toolName`、`result`、`isError` |

### 嵌套关系

```
agent
└── turn（可多个）
    └── message
        └── message_update（仅助手消息有）
```

---

## 2. 一次完整对话的事件顺序

**纯对话（无工具）：**

```
response → agent_start → turn_start
  → message_start(user) → message_end(user)
  → message_start(assistant) → message_update × N → message_end(assistant)
→ turn_end → agent_end → agent_settled
```

**含工具调用（两轮）：**

```
response → agent_start
→ turn_start
    message_start(user) → message_end(user)
    message_start(assistant) → message_update × N → message_end(assistant)
    tool_execution_start → tool_execution_update × N → tool_execution_end
    message_start(toolResult) → message_end(toolResult)
  turn_end
→ turn_start
    message_start(assistant) → message_update × N → message_end(assistant)
  turn_end
→ agent_end → agent_settled
```

---

## 3. 工具调用前**没有**权限确认握手

**这是本次最重要的发现。**

`tool_execution_start` 之后直接就是 `tool_execution_update`，中间没有任何请求授权的事件，Pi 也没有等待我们回话。

**结论：RPC 模式默认放行模型请求的一切工具调用。**

### 影响

1. **安全**：在实现权限门之前，探针等同于把 shell 完全交给模型。不要在有重要文件的目录运行，不要用可能触发写操作的 prompt。
2. **阶段 1 硬需求**：`packages/extensions/` 里第一个要写的就是权限门，用 `pi.on("tool_call")` 拦截 + `ctx.ui.confirm()` 询问。
3. **待解的架构难题**：确认对话框在 GUI 侧，拦截逻辑在核心侧，中间隔着 RPC。extension 的 `ctx.ui.confirm()` 如何穿过协议边界到达 Electron 窗口——这是阶段 1 最硬的一块，需要先查 Pi 的 extension UI protocol 是否已经为 RPC 模式定义了对应的事件。

---

## 4. RPC 进程在一次 prompt 结束后常驻，不退出

发出 `agent_settled` 后进程继续运行，等待下一条命令。需要显式关闭（`Ctrl+C` 或结束子进程）。

对设计的影响：`core-host` 需要负责进程生命周期管理——启动、健康检查、优雅关闭。GUI 关窗口时必须确保子进程被回收，否则会留下孤儿进程。

---

## 5. "本轮结束"的信号是 `agent_settled`

GUI 应据此重新启用输入框。

注意区分三个结束信号：

- `turn_end` —— 一轮结束，但 agent 可能继续下一轮（比如刚调完工具），**不能**据此解除输入锁
- `agent_end` —— agent 结束，附带完整消息历史
- `agent_settled` —— 真正的"可以接受新输入了"

---

## 6. 其他观察

### 消息的 role 有三种

`user`、`assistant`、`toolResult`。GUI 需要渲染三类，不是两类。

### 助手消息的内容分类型

`thinking`（推理过程，DeepSeek 这类推理模型会有）和 `text`（最终回答）是分开的两种 content。`message_update` 里的 `assistantMessageEvent` 也据此分出 `thinking_start`、文本增量等子类型。

GUI 设计题：思考过程要不要显示、怎么显示（折叠/灰字/开关）。

### 费用实时随消息返回

每条助手消息带 `usage`（token 数）和 `cost`（分项与总计）。GUI 做花费显示不需要自己计算。

实测：一句"你好"约 1932 tokens，$0.00086。

### `message_update` 的真正内容在内层

外层只是信封：

```json
{ "type": "message_update", "assistantMessageEvent": { "type": "thinking_start", "contentIndex": 0 } }
```

`core-client` 的 `events.ts` 应当把内层展平，前端不该关心这层信封。

### `toolCallId` 是并发的对号入座依据

工具输出流式回传时，靠它把 `partialResult` 贴到正确的 UI 卡片上。

---

## 7. 踩到的坑

### Node 无法直接 spawn `.cmd`

Windows 上 `pi` 实际是 `pi.cmd`。Node 18.20+ 出于安全考虑禁止直接 spawn `.cmd`/`.bat`，报 `spawn EINVAL`（注意不是 `ENOENT`——文件是找得到的，是启动方式被拒）。

当前用 `shell: true` 绕过，但会触发 `DEP0190` 弃用警告。当前参数全是写死的常量，无注入风险，但 **`core-host` 正式实现时应改为直接用 Node 启动 Pi 的入口 JS 文件**，绕开 shell。

### 认证：Claude Pro 订阅不适用于第三方应用

`/login` 用 Claude Pro 授权可以成功，但调用时报 400：第三方应用不再走套餐额度，改走需单独充值的 extra usage。

结论：本项目走 API key。DeepSeek 是 Pi 的内置 provider，环境变量 `DEEPSEEK_API_KEY`。

### 默认 provider 与实际凭据不匹配

`~/.pi/agent/settings.json` 里 `defaultProvider` 是 `anthropic`，但我们只有 DeepSeek 的 key，因此每次都要带 `--provider deepseek`。这正是 `core-host` 该统一收口的东西。

---

## 8. `~/.pi/` 目录结构

```
~/.pi/agent/
├── auth.json           凭据（明文 API key，勿外传）
├── settings.json       全局设置（theme / defaultProvider / defaultModel）
├── models-store.json   模型清单缓存
└── sessions/
    └── <工作目录编码>/   会话按工作目录隔离
        └── <时间戳>_<uuid>.jsonl
```

两点对设计有影响：

1. **"当前是哪个项目"是 Pi 的一等概念**，会话按工作目录分隔。GUI 必须处理项目切换。
2. **会话就是 JSONL 文件，一行一条**，与 RPC 协议同格式。这解释了会话树与分叉的实现方式，GUI 不需要自造存储格式。

---

## 9. 补充调查：Extension UI Protocol 与内置 RpcClient

来源：`<npm全局>/@earendil-works/pi-coding-agent/` 下的 `docs/rpc.md`、`examples/extensions/`、`dist/modes/rpc/*.d.ts`。
包内自带全套离线文档和 40+ 扩展示例，版本与安装版本严格一致，优先于网页文档。

### 9.1 权限确认的通道已由 Pi 定义（解决第 3 节的待解问题）

`docs/rpc.md` 的 "Extension UI Protocol" 一节：extension 调用 `ctx.ui.*` 时，RPC 模式会把它翻译成
建立在基础事件流之上的请求/响应子协议。

```
extension 调 ctx.ui.confirm()
  → stdout: { type: "extension_ui_request", id, method: "confirm", ... }   （核心阻塞等待）
  → 客户端弹窗，用户选择
  → stdin:  { type: "extension_ui_response", id, confirmed: true }
  → ctx.ui.confirm() 返回
```

- **阻塞式（需回应）**：`select`、`confirm`、`input`、`editor`
- **广播式（不需回应）**：`notify`、`setStatus`、`setWidget`、`setTitle`、`set_editor_text`
- 请求可含 `timeout`（毫秒），超时由核心侧自动以默认值兑现，客户端无需自行计时
- 响应三种形态：`{value}` / `{confirmed}` / `{cancelled: true}`，均按 `id` 配对
- RPC 模式下 `ctx.hasUI === true`、`ctx.mode === "rpc"`。需要真实终端的 `custom()` 等方法降级为
  no-op 或返回空值，写 extension 时用 `ctx.mode === "tui"` 守卫

**结论：不需要自造协议，照实现即可。** 原先标记为"阶段 1 最硬的一块"的问题已解除。

### 9.2 内置 `RpcClient` 可参考但不可直接用

包入口导出了 `RpcClient` 及配套类型。功能覆盖面很广：`prompt`、`steer`、`abort`、`setModel`、
`getAvailableModels`、`fork`、`getTree`、`getEntries`、`compact`、`exportHtml`、`waitForIdle` 等。

**但它无法回应 extension UI 请求：**

- `handleLine` 中，非 `response` 类型的行一律转发给事件监听器，所以 `extension_ui_request` **能收到**
- 但 `send()` 与 `process` 均为 private，**没有任何公开途径把 `extension_ui_response` 写回 stdin**

因此直接采用 `RpcClient` 会导致权限门无法工作。

### 9.3 阶段 1 的决定

**自己实现 `core-client`，但复用 Pi 导出的类型：**

```ts
import type {
  RpcCommand, RpcResponse,
  RpcExtensionUIRequest, RpcExtensionUIResponse,
  JsonAgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
```

省掉照 JSON 猜结构的工作，同时保留对双向通道的完全控制。`RpcClient` 的方法签名可作为
API 设计的参考实现。

### 9.4 其他值得回看的材料

- `examples/extensions/confirm-destructive.ts` —— `ctx.ui.confirm()` / `ctx.ui.select()` 的用法样板，
  并演示了用 `before_*` 事件返回 `{cancel: true}` 来取消操作
- `docs/rpc.md` 另有说明：Node 应用也可直接用 `AgentSession` 而不 spawn 子进程。
  本项目不采用——那会破坏"前端不 import Pi"的边界，且阻断阶段 3 的远程化
- 其余 40+ 示例覆盖自定义工具、自定义 provider、渲染器、状态栏等，阶段 4 打磨时值得逐个翻
