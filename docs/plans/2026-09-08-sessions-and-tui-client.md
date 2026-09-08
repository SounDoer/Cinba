# 多会话 + TUI 改成客户端

日期：2026-09-08
状态：已完成（阶段 A + 阶段 B，2026-09-08）

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

### Task 2-3

**5. `onSnapshot` 的参数涨到四个,改成一个对象。** 原来是 `(snapshot, cwd, model)`,
加上 `sessionId` 就四个了,位置参数开始难读。改成 `SnapshotState` 对象。

**6. `set_project` 和 `reset` 两条协议消息删掉了。** 它们的语义是「整个服务处于某个项目
模式」,而多会话之后每条对话自带工作目录,这个模式不存在了。选目录现在的含义是
`create_session`,`ProjectPicker` 的按钮也改成了「Start a conversation here」。
留着它们就等于同一件事有两条路。

### Task 4

**7. ⚠️ 一次 spawn 失败会把整个服务干掉——所有会话陪葬。**
实测撞到 `Error: spawn ... node.exe ENOENT`(Windows 上这个报错通常意味着**工作目录
不存在**,而不是 node 不见了),子进程的 `error` 事件没人监听,直接 unhandled 崩了整个
core-server。单会话时代这个风险也在,只是一个进程死了本来也就全死了;多会话之后
**一条对话起不来绝不能拖垮别人**。

已修:`open()` 先查目录是否存在,给子进程挂 `error` 监听,并让 `getState()` 和失败事件
赛跑——否则进程已死,调用方会永远等一个不会来的回复。

**根因没能复现**,当时的状态已经没了。修的是后果(服务不再整体崩溃)和诊断(现在会打印
`starting Pi in <目录>`,失败时打印目录名),不是根因——这点如实记下。

**8. 新建的会话不落盘,说第一句话之后才出现在列表里。**
实测:`create_session` 之后文件数 39 → 39,发一次 prompt 之后 → 40。Pi 的
`SessionManager` 是延迟写的。

**决定:接受,不做处理。** 空对话不进列表反而更干净。副作用是「新建之后还没说话就刷新
页面,这条会话就没了」——但退路是通的:`lastSessionId` 指向一个不存在的文件时,
`findSessionPath` 返回 undefined,自动落到最近一条真实会话。

**9. core-server 一度要直接 import Pi(`SessionManager`),改成放进 core-host。**
理由是设计文档第 6 节那条:「`core-host` 单独成包,保证『我的 agent』只有一处定义」。
Pi 的接触面留在一个包里,Task 10 那张接口依赖清单才列得清楚。
core-host 因此新增 `listSessions()` / `findSessionPath()` / `CoreOptions.sessionPath`。

**10. 实测确认(阶段 A 的核心功能)**

```
连上 → 自动打开上次那条会话，从磁盘重建（你早上那条游戏能力翻译的对话，含 thinking 和表格）
list_sessions(Cinba) → 38 条，标题用 firstMessage
open_session(那条 42 的) → 10 条记录，"42" 在里面
两个客户端各看各的会话，互不干扰
新会话里发一句 → user/assistant 一问一答正常
```

### Task 5-6

**11. 对账不能按 id 比,只能按内容比。** 实时折叠用的是我们自己发的消息 id(`m1`、`m2`),
从磁盘重建用的是 Pi 的 id。直接深比较会**每一轮都报"不一致"**,对账就成了摆设。
因此新增 `sameTranscript()`,按 role/文本/思考/工具名/状态/结果比,忽略 id。

**12. 对账改成「一致就不动」,而不是无条件替换。** 无条件替换的话,每轮结束都会把易失的
`notice`(比如「aborted」)冲掉——你刚点了 Stop,提示闪一下就没了。改成先比对,一致就
什么都不做,notice 保住原位;真有偏差才以 Pi 为准整体替换,并打一条 warning。
实测一轮正常对话:**没有漂移警告**,对账安静通过。

**13. ⚠️ 真 bug:打开别的目录的会话时,Pi 起在了错误的工作目录。**
`open_session` 用的是模块级的默认 `cwd`,不是那条会话自己的 `cwd`。后果是一条关于 Desktop
的对话,恢复之后它的工具会跑在 Cinba 目录里——**在一个项目里执行另一个项目的命令**。

已修:`core-host` 的 `findSessionPath()` 改成 `findSession()`,连 `cwd` 一起返回;
`show()` 里顺带把默认 cwd 跟到当前会话,新建对话就落在你刚看的那个项目里。

**14. 批量替换漏了一条,而 `assert` 被其他成功的替换掩盖了。**
顶栏按钮那条没匹配上,结果是「会话列表根本打不开」——组件、协议、服务端全做好了,
就是没有入口。正是「逐条替换成功掩盖了整体没做完」这个老问题;改完之后要扫一遍
「该消失的东西是不是真消失了」。

**15. 权限门拒绝路径已重验(通过 core-server,因为改动在 `pendingConfirms` 的归属)。**

```
confirmation raised -> answering NO
tool card status: error | result: "The user denied this tool call"
model's reply: "I attempted to run `ls`, but the tool call was denied, so I couldn't see
                the directory contents..."
```

两条硬性条件都满足:命令没执行,且模型知道自己被拒了。

**16. 阶段 A 的界面实测**

```
顶栏「Cinba — conversations」→ 51 条会话，当前那条标 ●
每行：标题（firstMessage）· 项目名 · 消息数 · 时间 · Delete（两步确认）
切到 Desktop 那条 → 顶栏变「Desktop — conversations」，正文换成那条对话
切回 Cinba 那条   → 顶栏和正文都跟着回来
```

### Task 8

**17. TUI 需要一个以前不需要的能力:整屏重画。**
它的 `Transcript` 是只追加的(阶段 2 的设计:滚过去的行改不了)。但现在一整段对话会一次性
到达——打开一条会话时,以及服务端对账纠正时。加了 `clear()`,并新增 `drawSnapshot()`
把账本快照整段画出来,和逐条追加的 `applyAction()` 并存:**流式用追加,整段用重画**。

**18. TUI 的落点规则和服务端的默认不一样,而且 TUI 的规则更老。**
服务端给新连接的是「上次用的那条会话」,可能属于别的项目;而终端的规矩是
「你在哪个目录启动就在哪个目录干活」。所以 TUI 连上之后自己要一次 `list_sessions(cwd)`,
在本目录的会话里挑最近的一条打开,没有就新建。**`cd proj && 起 TUI` 的手感一个字没变。**

代价:服务端仍然会为它的默认会话起一个 Pi,而 TUI 随即换到别的会话去了。多一个进程,
无害,先接受。

**19. 连不上时打印一行提示后退出,不自动拉起服务。** 实测输出:

```
Cannot reach the Cinba service at ws://127.0.0.1:4517/ws.
Start it first: double-click cinba.cmd in the repository root.
--- exit code: 1 ---
```

**20. `@cinba/tui` 不再依赖 `@cinba/core-host`。** 它现在只依赖 `core-client`,
和 `web` 一样——这正是设计文档第 5 节要求的前端依赖形态。**TUI 第一次真正满足它。**

**21. 实测:TUI 连上后画出了完整的历史对话**,含 `-- deepseek/deepseek-v4-pro --` /
`-- deepseek/deepseek-v4-flash --` 两个模型标记,和 GUI 看到的是同一条会话。

**未验证的部分要说清楚:在 TUI 里打字发送这条路没能自动化验证**——它要一个真的终端
(pty),脚本喂 stdin 驱动不了。发送走的是 `remote.prompt()`,和网页端同一条已验证的路径,
但 `onSubmit` 那十行是新写的,**需要人工在真终端里敲一次确认**。

### Task 9-11

**22. TUI 的 `Transcript` 从"行缓冲"改成了"块"。**
`Markdown` 是个按宽度渲染的组件,而宽度只有渲染时才知道;文本也只有说完了才排得了版。
所以 Transcript 现在存的是块:普通块是若干行,消息块存的是 Markdown 源码,画的时候才渲染。
**流式期间按行追加,一轮结束整段重画成 Markdown。**

重画的时机是 `busy_changed:false`,而且要延后一个 tick——一批动作是分条到达的,
在第一条上就重画会画出半应用的状态。

**23. ⚠️ 反斜杠又被吃了一层,和记忆里那条一模一样。**
python 脚本里写 `split("\n")`,到 python 手里变成了真换行,替换于是匹配不上。
这次幸好断言拦住了(而且写盘在最后,所以是原子的)。**结论仍然是:带反斜杠的编辑用 Edit
工具或 Write,不要穿过 shell。**

**24. 状态栏的提示在 80 列下被截断了**(`Ctrl+P m...`)。功能对但看不全,和阶段 2
「暗灰色状态栏等于隐形」是同一类问题。缩短成 `^O conv · ^P model · ^C exit`。

**25. Markdown 主题是自己写的十几行,没有借 `pi-coding-agent` 的 `getMarkdownTheme()`。**
因为 `@cinba/tui` 不能依赖 Pi——那正是第 5 节的依赖规则,而这次改造的全部意义就是让 TUI
第一次真正满足它。为了省十几行去破规则不划算。

**26. 权限门重验,两条路都过了。**

设计文档第 9 节规定的原路(`scripts/repl.ts` 答 n):

```
⚠️  Allow bash?  {"command": "ls"}
Allow? (y/N) n
thinking: "The user denied the tool call..."
text: "I wasn't able to run the `ls` command — the tool call was denied."
```

以及走 core-server 的那条(因为 `pendingConfirms` 挪进了会话):工具卡片 error、
结果为「The user denied this tool call」、模型明确说自己被拒。

**两条硬性条件都满足:命令没执行,模型知道自己被拒了。**

**27. 阶段 B 实测**

```
cd Cinba && 起 TUI
  → 落在本目录最近那条会话，整段历史画出来
  → `ls` 渲染成行内代码，长段落按宽度折行     ← Markdown 生效
  → 工具卡片：[tool] bash  denied or failed
  → 状态栏：13310 tokens · $0.0011 · deepseek-v4-flash    ^O conv · ^P model · ^C exit
服务没起时 → 一行提示 + exit 1，不自动拉起
```

**要人工验证的两块,用户已在真终端里确认(2026-09-08):**

- Ctrl+O / Ctrl+P 两个选择器可用(自动化驱动不了,要真终端 pty)
- **网页端和 TUI 能同时各自工作在不同的会话里** —— 这一条正是「每个打开的会话一个 Pi」
  那个决定要换来的东西:共用一个进程靠 `switch_session` 轮换的话,同一时刻只有一条对话
  跑得动,这个场景就不成立。决定与实测对上了。

### 收尾（斜杠命令）

**28. ⚠️ 焦点给错了对象,菜单从来没出现过。**
`tui.setFocus(promptInput.input)` —— 焦点落在内层 `Input` 上,按键直接进了它,
包在外面那层 `PromptInput.handleInput`(负责刷新菜单)**一次都没被调用过**。
四个命令能用,是因为打完整名字回车走的是 `onSubmit`,那条路不经过菜单。

修法:让 `PromptInput` 自己实现 `Focusable` 成为焦点,并把 `focused` 透传给内层 `Input`
(否则光标就没了——TUI 把标志设在它 focus 的那个对象上,而只有 `Input` 知道光标在哪)。

**不能改成在 `tui.addInputListener` 里刷新**:实测 pi-tui 的输入监听器**先于**焦点组件
运行(`tui.js:662` 在 `718` 之前),那时 `getValue()` 还是上一个字符的值,菜单会永远慢一拍。

**29. ✅ 之前说"TUI 的交互必须人工验证"是错的——管道喂 stdin 就够。**
`ProcessTerminal` 读的是 `process.stdin`,不要求 TTY。

```bash
{ sleep 5; printf '/'; sleep 4; } | timeout 14 node packages/tui/src/index.ts
```

输出里能直接看到菜单渲染:

```
> /help     list these commands
  /model    switch model, keeping this conversation
  /new      start a conversation here
  /sessions switch to another conversation
> /
```

打 `/se` 收窄到 `> /sessions`,也验过。**这一条推翻了 Task 8 的执行期发现里
「打字发送没法自动化验证」那句** —— 当时放弃得太早了,后果是这个焦点 bug 一直到用户
手工测才暴露。以后 TUI 的交互一律用管道验。

**30. 目录里的排列顺序其实是无效的**(`matchCommands` 会排序),看着像"按重要性排"
其实不是。已改成字母序并写明,免得以后有人调整顺序却毫无效果。

**31. ⚠️ 菜单长得像可选列表,却不能选——设计上漏了一步。**
第一版做的是"提示":`>` 标着回车会执行哪条,但方向键不归它管(方向键进了 `Input`,
在文本里左右移动)。**它带着 `>` 标记,任何人都会去按方向键。**

修法:菜单显示时,`PromptInput` 把上/下/Tab 截走自己用,其余按键照常进 `Input`
(所以打字仍然收窄列表)。回车执行的改成**高亮那条**,不再是第一条。收窄时如果高亮那条
还在,高亮跟着它走;不在了才回到第一条。

实测(管道驱动):

```
/ → 菜单出现，> /help
↓ → > /model
↓ → > /new
/ ↓ Enter → 打开的是模型选择器，不是 /help
```

**教训和第 24 条("暗灰状态栏等于隐形")、阶段 2 那条是同一类:功能正确 ≠ 用户能用。**
一个带光标标记的列表就是在承诺"可以选",承诺了就得兑现。
