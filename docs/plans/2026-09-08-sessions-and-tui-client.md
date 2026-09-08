# 多会话 + TUI 改成客户端

日期：2026-09-08
状态：执行中（阶段 A Task 1 完成）

这是 3a 之后最大的一次结构改动，分两阶段，各自可独立验收：

- **阶段 A**：core-server 支持多会话，GUI 能列出/新建/打开/删除会话
- **阶段 B**：TUI 从「自己起 Pi」改成「core-server 的客户端」，两端功能对齐

阶段 A 做完 GUI 就能用，阶段 B 可以隔一段时间再做。

## 为什么要做

设计文档第 8 节记的那条待解问题：**TUI 是第二个核心宿主，不是客户端**
（`packages/tui/src/index.ts:207` 是裸的 `startCore()`）。后果已经能看到——TUI 不读
`~/.cinba/config.json`，GUI 里切的模型它完全不知道。这是第 5 节担心的「长出两份互相
不一致的 agent」。

用户的要求是两端功能一致、且都由我们自己设计。因此：

- **「阶段 2 刻意做朴素」这条约定作废**。那是在「TUI 只在服务器上凑合用」的前提下写的。
- TUI 要能多开、要能同项目多条对话，所以多会话是它的前置条件。

## 开工前的实测（2026-09-08，探针跑完即删）

**结论：Pi 已经把持久化多会话做完了，我们是接线，不是造存储。**

**1. 会话一直在磁盘上。** `~/.pi/agent/sessions/--<编码过的 cwd>--/*.jsonl`，
Cinba 这个目录下已经积了 38 个，全部目录 51 个。

**2. 存的内容比我们的账本全。** 今天那个测试会话的实际内容：

```
session          cwd: C:\Users\shenxichen\repos\Cinba
model_change     deepseek-v4-pro
message user     "Remember the number 42..."
message assistant "ok"
model_change     deepseek-v4-flash      ← 模型切换记在正确位置
message user     "What number did I ask..."
message assistant "42"
```

工具调用、工具结果、thinking、每条消息的 token 与花费都有。
**「哪条是哪个模型答的」Pi 记得比我们那条 `notice` 准。**

**3. 重启接得回去。** 新起一个 Pi 进程指向那个会话文件，问「我让你记的数字是多少」，
答 `42`。不同进程、几小时之后，上下文完整。

**4. 列会话不用起 Pi。** `SessionManager.list(cwd)` 13ms，返回 `id / cwd / name /
messageCount / firstMessage / created / modified`。**`firstMessage` 天然就是列表标题。**

**5. 活着的进程能换会话。** `switch_session` 和 `new_session` 在运行中的 RPC 进程上都成功。

**推翻了计划前的两个假设：**

- ~~会话持久化要自己设计存储格式和清理策略~~ → 不用，存储是 Pi 的
- ~~Pi 的 cwd 启动后换不了，所以一个会话必须一个进程~~ → 目录换不了是对的，
  但同目录下的会话可以在一个进程里切换

## 已确认的决定

| 问题 | 决定 | 理由 |
|---|---|---|
| 同一项目能否多条对话 | **能** | 用户明确要求，Claude Code / Codex 那种形式 |
| 会话是否持久 | **持久，只有用户主动删** | 骑 Pi 的存储，几乎白送 |
| 进程模型 | **每个「打开的」会话一个 Pi** | 同项目可共用一个进程靠 `switch_session` 轮换，但那样同一时刻只有一个会话能跑，会杀掉「一边跑长任务一边另一条对话里问问题」这个多会话的主要价值 |
| 是否自动回收闲置 Pi | **第一版不做** | 只做懒启动：打开哪个会话才起哪个 Pi。进程数 = 本次开机实际打开过的会话数，通常个位数，server 重启归零。磁盘上有 Pi 的完整记录，将来要加回收很安全 |
| 账本留不留 | **留，但降级为「投影」** | 见下节 |
| 删除会话 | **删对应的 `.jsonl` 文件，二次确认** | Pi 的会话是只追加设计，没有删除 API，删除逻辑归我们 |
| 启动时的会话 | **自动打开上次那个** | 和现在「记住上次的项目目录」同一个思路 |

### 账本的新身份

**Pi 的会话文件是历史的唯一真相源。** 账本（`session.ts`）不是第二个真相源，是它的投影：

```
Pi 的会话文件  =  过去（已完成、已落盘）
我们的账本      =  过去的投影  +  还没落盘的现在
```

账本不可替代的部分是「现在」：正在流的半句回答、待确认的工具卡片——这些在 Pi 的文件里
根本不存在（消息要完成才落盘）。去掉账本的话，模型答到一半刷新页面那半句就没了，
而且 3a 把账本放到服务端的理由（「已经流走的事件找不回来」）也没了。

配套四条，用来保证它只是缓存、不会和真相源分家：

1. **`notice` 降级为易失的界面提示**，重载后消失。这样账本里不再有任何独有的持久数据。
2. **「模型切换」的 notice 删掉**，改用 Pi 的 `model_change` 条目——它更准，位置也对。
3. **打开会话时**用 `get_entries` 重建账本。
4. **每轮结束时（`agent_settled`）用 `get_entries { since }` 增量对账。**
   走本地管道，不花钱不联网。效果：折叠器若把某个事件理解错了，偏差最多存活一轮就自愈。
   今天的账本是无人校对的，改完之后每轮都跟真相源核对一次，比现在更严格。

## 不做

- 不做会话分叉 / 会话树（Pi 有 `fork` / `get_tree`，以后想要再接）
- 不做自动回收闲置 Pi（见上）
- 不做会话搜索、标签、导出
- 不碰远程接入（形态 C 的第 2、3 步）
- 不做 compact（用户明确说先不管）

## 安全

**权限门不变**：仍由 `core-host` 无条件挂载，五个测试照旧。多会话之后每个 Pi 进程各自
挂一份，`pendingConfirms` 要从全局改成**按会话**存放——这是本次唯一碰到权限门周边的
改动，因此**收尾时必须手工过一遍拒绝路径**：

```
node scripts/repl.ts "run the ls command"     出现确认时答 n
```

必须同时看到：命令没执行（`isError` 为 true），且模型知道自己被拒了。

**监听地址不变**：`127.0.0.1`。本次不碰网络。

**新增风险要记档**：本次方向大量依赖 Pi 的 RPC 命令与导出 API，接触面比「扩展写得极小」
那条防御设想的大。代价值得付（自己造会话存储要写的代码远多于接线，且不会做得更好），
但配套防御要跟上——见 Task 10。

---

# 阶段 A：core-server 多会话

### Task 1：会话条目 → 界面动作的折叠器 → 验证：单元测试

新增 `packages/core-client/src/entries.ts`：`foldSessionEntries(entries) → ViewAction[]`。

和已有的 `createEventFolder`（Pi 事件 → 界面动作）结构对称，但输入是 Pi 会话文件里的
条目。**纯函数，不起 Pi、不花钱就能测。**

要处理的条目类型（实测确认存在）：`message`（role 为 user / assistant / toolResult）、
`model_change`、`thinking_level_change`；消息内容里有 `text` / `thinking` / `toolCall`。

重建规则：
- `toolCall` + 后续的 `toolResult` → 一张 `tool_changed` 卡片，状态从结果算（done / error）
- 助手消息的 `usage` 累加成 `usage_changed`
- 待确认状态不重建（重载后本来就不该还有"等你点确认"的卡片）

测试用真实会话文件的内容做样本，内联进测试文件。

### Task 2：`CoreClient` 加会话命令 → 验证：单元测试

`get_entries`（支持 `since`）、`new_session`、`switch_session`、`set_session_name`。
照 Task 1 那次模型命令的写法，用现有的假 transport 测。

### Task 3：协议扩展 → 验证：`protocol.test.ts`

```ts
ClientMessage += | { type: "list_sessions"; cwd?: string }
                 | { type: "open_session"; sessionId: string }
                 | { type: "create_session"; cwd: string }
                 | { type: "delete_session"; sessionId: string }

ServerMessage += | { type: "session_listing"; sessions: SessionSummary[] }
                 | { type: "session_opened"; sessionId: string }

type SessionSummary = {
  id: string; cwd: string; name?: string;
  messageCount: number; firstMessage: string; modified: string;
};
```

`snapshot` 增加 `sessionId`。`prompt` / `abort` / `respond_confirm` 不变——它们作用于
「该客户端当前打开的会话」。

### Task 4：core-server 改造 → 验证：手工开两个会话分别对话

状态从「一个 cwd + 一个账本 + 一个 Pi」变成：

```ts
sessions: Map<sessionId, {
  cwd: string; sessionPath: string;
  pi: CoreClient | undefined;        // 懒启动：打开才起
  ledger: Session;
  pendingConfirms: Map<string, (ok: boolean) => void>;   // 从全局挪进来
}>
viewing: Map<WebSocket, sessionId>   // 每个客户端在看哪个
```

- 广播改成**按会话**：只发给正在看它的客户端
- `list_sessions` → `SessionManager.list(cwd)`，不起 Pi
- `open_session` → 起 Pi（`--session <path>`）、`get_entries` 重建账本、发 snapshot
- `create_session` → 起 Pi、新会话
- `delete_session` → 停掉它的 Pi（若在跑）、删文件
- 配置从 `{ cwd, provider, modelId }` 加一个 `lastSessionId`

### Task 5：每轮对账 → 验证：单元测试 + 手工

`agent_settled` 时发 `get_entries { since: 上次对账的最后一个 id }`，把新条目折叠后
和账本比对，不一致就以 Pi 为准修正。

### Task 6：GUI 会话列表 → 验证：手工

`packages/web/src/SessionPicker.tsx`，样式照 `ProjectPicker` 抄。列出会话（标题用
`firstMessage`）、新建（先用 `ProjectPicker` 选目录）、删除（二次确认）。

顶栏的「Project」按钮语义随之改变：从「切换当前项目」变成「新建会话时选目录」。

### Task 7：阶段 A 回归 → 验证：`node --test "packages/*/src/*.test.ts"` + 权限门手工重验

---

# 阶段 B：TUI 改成客户端

### Task 8：入口换成 WebSocket → 验证：手工，和 GUI 看到同一个会话

`startCore + CoreClient + createEventFolder` → `WebSocket + RemoteSession + createSession`，
和 `main.tsx` 里那 20 行同构。画的部分先原样不动。

- 启动时按当前目录列会话：有就打开最近那个，没有就新建一个。**`cd proj && 起 TUI` 的手感不变**
- 连不上 server：打印「没找到 Cinba 服务，请先启动 cinba.cmd」后退出。**不自动拉起**——
  自动拉起会带来「谁关它、日志打哪、Ctrl+C 之后 GUI 的对话是不是也没了」三个问题

### Task 9：TUI 补齐 → 验证：手工

服务端那一半已经有了，只需要画：

- **Markdown 渲染**（`pi-tui` 自带 `Markdown` 组件，我们那 344 行只用了 `Input` /
  `SelectList` / `Container` 三个——现在的朴素有一半是没去用现成零件）
- 模型选择器、会话列表、项目选择（都用 `SelectList`）
- 可选：`renderDiff` / `highlightCode`（`pi-coding-agent` 导出的纯渲染函数）

### Task 10：文档收尾 → 验证：读一遍

1. 设计文档第 7 节：删掉「阶段 2 刻意做朴素」，写明它为何作废
2. 第 8 节：把「TUI 是第二个核心宿主」那条移到已解决
3. **第 9 节新增「Pi 接口依赖清单」**——现在只有权限门一条重验步骤，扩成一张表：
   每个我们依赖的 Pi 接口（命令行参数 / RPC 命令 / 导出 API）对应一条验证方法，
   升级 Pi 之后照着过一遍。这是接触面变大之后必须补上的防御。

### Task 11：全量回归 → 验证：全绿 + 权限门手工重验

基线 57 个。

---

## 执行期发现

### Task 1

**1. 拿 51 个真实会话文件跑了一遍折叠器,没有一种条目类型是它不认识的。**
实际出现的只有 `message` / `model_change` / `thinking_level_change` 三种,
折出 183 条消息、31 张工具卡、55 个模型标记,没有一个文件折出空结果。
计划里「用真实文件当样本」这条落实了,而且顺带确认了覆盖面。

**2. ⚠️ 空的 assistant 消息——早就存在的渲染问题,这次才暴露。**
模型直接去调工具、一个字都没说时,那条 assistant 消息的 content 里只有 `toolCall`,
没有 text 也没有 thinking。51 个文件里有 14 个存在这种消息。

它渲染出来是一个空气泡。**实时那条路一样有这个问题**（`message_start` 对每条 assistant
消息都建气泡),只是一直没人注意。修在渲染层(`Transcript.tsx` 跳过 text 和 thinking
都为空的消息),两条路一起好——而且这本来就是渲染的决定,不该让账本为此丢数据。

**3. `session.ts` 的头部注释写着「This is the single source of truth」,这次改动让它失真。**
已改成「投影,不是真相源」,并写明了它不可替代的部分是「还没落盘的现在」。

**4. 模型标记用了新的界面动作 `model_in_use` + 账本条目 `kind: "model"`,不是复用 `notice`。**
因为 `notice` 已经被定义成「易失的界面提示,重载后消失」,而模型标记要能从 Pi 的
`model_change` 条目重建出来——两者身份不同,混用会把刚理清的 SSOT 关系又搅浑。
