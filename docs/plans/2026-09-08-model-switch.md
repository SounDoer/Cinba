# 基础功能：模型切换

日期：2026-09-08
状态：已完成（2026-09-08）

这不是一个阶段，是阶段 3b-2 之前的一个小功能。定位见 `docs/specs/2026-09-06-cinba-design.md`
第 1 节的第一条动机「模型/厂商自由」——provider 目前写死在 `core-host` 的
`DEFAULT_PROVIDER`，界面上碰不到。

## 开工前的实测（2026-09-08）

两个探针，跑完即删，结论写在这里：

**1. Pi 能直接给出「我真的能用的」模型列表。**
`ModelRuntime.create()` 24ms、`getAvailable()` 5ms，纯读本地不联网（`allowModelNetwork`
默认 false）。它认识 40 个 provider，但只有 deepseek 一个 `configured: true`——
key 在 `~/.pi/agent/auth.json` 里。**所以列表问 Pi 要，不写死**：写死的列表会烂，
而且会列出没有 key、点了就报错的项。

**2. 切模型不需要重启 Pi。** 这一条推翻了立项时的假设。Pi 的 RPC 模式本身就有：

```
get_state              → 当前模型
get_available_models   → 可用模型列表
set_model {provider, modelId}
```

（`dist/modes/rpc/rpc-mode.js:367-386`）实测在活着的 RPC 进程上：

```
get_state ok: true model: deepseek deepseek-v4-pro
get_available_models ok: true count: 3
set_model ok: true now: deepseek deepseek-v4-flash
state after: deepseek deepseek-v4-flash
set_model bad: {"success":false,"error":"Model not found: nope/nope"}
```

`getAvailableSnapshot()` 是同步读快照，本来担心启动瞬间为空——实测已填好，不用等。

**因此「切模型」和「切项目」在结构上并不是同一件事。** 切项目要换 Pi 的 cwd，只能重启；
切模型是给活着的 Pi 发一条命令。协议消息、配置持久化、界面选择器这三样照抄 `set_project`，
**但不抄 `startSession()` 那一步**。

## 已确认的决定

| 问题 | 决定 | 理由 |
|---|---|---|
| 列表从哪来 | 问 Pi（`get_available_models`） | 见上。且这条路 fail-soft：Pi 升级后若命令没了，症状是「列表空了」，吵闹而无害 |
| 每项目一个还是全局一个 | 全局一个 | 模型选择跟着任务性质和花钱意愿走，不跟着项目走。将来想改成按项目，配置文件加一张表即可，不破坏结构 |
| 要不要清空对话 | 不清空 | 既然不重启就没理由清空。保留上下文正是这功能最有用的场景：flash 答得不好，切 pro 接着说 |
| 要不要记住选择 | 要 | 存 `~/.cinba/config.json`，启动时用 `--provider/--model` 起 Pi。否则每次开都退回默认，切了白切 |

`DEFAULT_PROVIDER` 从「硬编码的唯一答案」降级为「配置为空时的兜底」。

## 不做

- **TUI 不加模型选择器。** 设计文档第 7 节写明阶段 2 刻意朴素，那些留到阶段 4。TUI 直连
  `CoreClient`，本次改动不会碰坏它。
- 不做「按项目记模型」，不做模型的搜索/分组/图标，不做 thinking level（Pi 也有
  `set_thinking_level`，那是另一个功能，另说）。

## 安全

本次不碰权限门、不碰监听地址、不碰 markdown 渲染。因此设计文档第 9 节那条手工重验
（`node scripts/repl.ts` 答 n）本次不触发。若实现中意外改到权限门相关代码，停下来告知用户
并补跑。

## 任务

### Task 1：`CoreClient` 增加三条命令 → 验证：新增单元测试通过

`packages/core-client/src/client.ts`。请求/应答通道（`#send`）已经有了，只是加方法：

```ts
getState()                            → #send({ type: "get_state" })
getAvailableModels()                  → #send({ type: "get_available_models" })
setModel(provider, modelId)           → #send({ type: "set_model", provider, modelId })
```

测试（`client.test.ts`，用现有的假 transport）：三条命令各自发出正确的 JSON 且带 id。

### Task 2：协议增加消息 → 验证：`protocol.test.ts` 通过

`packages/core-client/src/protocol.ts`：

```ts
type ModelRef = { provider: string; id: string };

ClientMessage += | { type: "list_models" }
                 | { type: "set_model"; provider: string; modelId: string }

ServerMessage += | { type: "model_listing"; models: ModelRef[] }
                 | { type: "model_changed"; model: ModelRef }
```

`snapshot` 消息增加 `model?: ModelRef` 字段——它和 `cwd` 是同一类「会话级事实」，
新连上的客户端一次拿全。

`parseClientMessage` 对 `set_model` 校验两个字段都是非空字符串。

### Task 3：`RemoteSession` 收发 → 验证：`remote.test.ts` 通过

`packages/core-client/src/remote.ts`：加 `listModels()` / `setModel()` 两个发送方法，
`onModelListing` / `onModelChanged` 两个回调，`onSnapshot` 多带一个 model 参数。

### Task 4：`core-server` 落实 → 验证：手工跑起来切一次

`packages/core-server/src/index.ts`：

1. `loadCwd/saveCwd` 扩成 `loadConfig/saveConfig`，配置从 `{ cwd }` 变成
   `{ cwd, provider?, modelId? }`。
2. `startSession()` 把 provider/model 传给 `startCore`；启动后发一次 `get_state`
   问回真实的当前模型（配置为空时 Pi 自己挑，只有问才知道挑了谁），存下并广播
   `model_changed`。
3. `list_models` → 向 Pi 要列表，广播 `model_listing`。**广播而非只回请求方**，
   与既有的 `dir_listing` 保持一致（`handle()` 目前拿不到 socket）。
4. `set_model` → 调 Pi；成功则存配置、广播 `model_changed`、往账本里插一条
   `notice`（`model → deepseek-v4-flash`），这样回头看记录知道哪几条是谁答的；
   失败则只插一条 notice 说明原因。

### Task 5：界面 → 验证：双击 `cinba-dev.cmd`，切一次模型，对话接着说

`packages/web/src/ModelPicker.tsx`（新）+ `main.tsx` 顶栏加一个按钮，
样式照 `ProjectPicker` 抄。忙碌时禁用切换，理由与输入框相同：一句话答到一半不换脑子。

### Task 6：全量回归 → 验证：`node --test "packages/*/src/*.test.ts"` 全绿

基线 53 个。

## 执行期发现

**1. 顶栏从两栏变三栏。** `header` 是 `justify-content: space-between`，原本只有
「项目按钮 / 用量」两个元素。加了模型按钮之后变成三个，模型按钮被推到正中——看着还行，
没改 CSS。将来顶栏再加东西就得重新安排了。

**2. `get_state` 的回应要防「回来时会话已经换人」。** `startSession()` 发出 `get_state`
之后是异步等回应的，期间用户可能已经切了项目、`client` 换成了新的一个。回调里加了
`if (client !== next) return`，否则旧会话的模型会盖掉新会话的。

**3. 配置文件从 `{ cwd }` 变成 `{ cwd, provider, modelId }`，没有做迁移。** 旧文件缺
provider/modelId 两个字段，`loadConfig` 的类型检查不通过就跳过，落到 Pi 自己的默认——
正是想要的行为，所以不需要迁移代码。

## 实测记录（2026-09-08）

浏览器里跑通的完整路径：

```
Model: deepseek-v4-pro              ← 启动后 get_state 问回来的真实值
[列表] ● deepseek/deepseek-v4-pro + 另外两个
「记住数字 42」→ pro 答 ok
切到 flash → 账本里出现 notice: model → deepseek/deepseek-v4-flash
「我让你记的数字是多少」→ flash 答 42        ← 上下文跨模型保住了
~/.cinba/config.json 写入 modelId: deepseek-v4-flash
重启服务 → 顶栏直接显示 deepseek-v4-flash   ← 记忆生效
```

测完已切回 `deepseek-v4-pro`。测试 53 → 57 全绿。
