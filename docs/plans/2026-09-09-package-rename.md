# 重构：让包名与包的内容对上

日期：2026-09-09
状态：已完成（2026-09-09）

不加功能，不改行为。只做一件事：**让三个包的名字说出它们实际是什么**。

## 为什么现在做

`core-client` 这个名字骗人：它**不是 `core-server` 的客户端**。看依赖图就清楚——
`core-server` 自己就依赖它。它是一个库，服务端和所有前端都 import。

更要紧的是，**设计文档第 3 节的架构图已经不描述它了**。原图写的是：

```
协议层  core-client：收发 JSONL、把原始事件变成类型化事件
```

那只是「对 Pi 说话」那一半。3a 之后它长出了第二份工作（对前端说话），
**而架构图里从来没有那一层**。所以这不是重新设计，是让代码回到架构图，
外加给 3a 添的那层起个名字。

## 实测：里面确实是两半，切口很干净

统计了三个消费方实际 import 的符号：

| 谁用 | 符号 |
|---|---|
| **只有 core-server** | `CoreClient` `StdioTransport` `createEventFolder` `foldUiRequest` `foldSessionEntries` `sameTranscript` |
| **server + 两个前端** | `RemoteSession` `parseClientMessage` `createSession` `ViewAction` `labels` `commands` 以及各种类型 |

**两个前端一个都没用过 Pi 那一半。** 所以不是「要不要拆」，是「它本来就是两个东西」。

## 目标形态

```
前端层    web / tui / desktop     只依赖 contract，永不碰 Pi
契约层    contract                协议消息 + 账本 + 界面动作 + 两端共同的措辞（零依赖、浏览器安全）
服务层    server                  唯一跑着的进程
核心层    agent                   唯一碰 Pi 的地方
          extensions              权限门（保持独立，见下）
```

| 现在 | 改成 |
|---|---|
| `core-host` | `agent` —— 它是「我的 agent 是什么样」的定义，不 host 任何东西 |
| `core-client` 的 Pi 那半 | 并进 `agent` —— 于是「Pi 的接触面」正好等于一个包 |
| `core-client` 的契约那半 | `contract` —— 谁也不依赖、谁都能用，包括浏览器 |
| `core-server` | `server` |

**`extensions` 保持独立**：Pi 用 `-e <文件路径>` 加载它，必须是能被解析到的独立文件；
而且它是唯一的安全设施，23 行、5 个测试单独放着反而清楚。

## 文件去向

**`contract`（新包，零依赖）**

```
actions.ts     ← 从 events.ts 拆出 ViewAction / ToolStatus（前端要用，但折叠器不该跟来）
session.ts     ← 原样搬，外加从 entries.ts 搬来的 sameTranscript（它只比较账本，不碰 Pi）
protocol.ts  remote.ts  labels.ts  commands.ts   ← 原样搬
```

**`agent`（原 core-host + Pi 那半）**

```
index.ts  credentials.ts          ← 已在，不动
pi-client.ts   ← 原 client.ts。`CoreClient` 改名 `PiClient`：它就是 Pi 进程的客户端
transport.ts  line-splitter.ts    ← 原样搬
events.ts     ← 只剩折叠器与 extractText，类型已挪到 contract
entries.ts    ← 只剩 foldSessionEntries
```

`agent` 会因此依赖 `contract`（它生产 ViewAction）。方向仍是单向的，没有环。

**`server`（原 core-server）**：文件不动，只改包名与 import。

## 顺带改的两个名字

| 现在 | 改成 | 理由 |
|---|---|---|
| `CoreClient` | `PiClient` | 「core 的客户端」正是那个骗人的说法；它是 Pi 进程的客户端 |
| `startCore` | `startPi` | 新结构里没有叫 core 的东西了；它启动的是一个 Pi 进程 |

其余符号（`StdioTransport` / `createEventFolder` / `foldSessionEntries` / `RemoteSession`）
名字本来就对，不动。

## 不做

- 不改任何行为，不加功能
- 不动 `extensions`、`web`、`tui`、`desktop` 的包名
- 不拆 `server`（它就是一个进程，本来就该是一个包）

## 任务

### Task 1：建 `contract` → 验证：`npm test` 全绿

`git mv` 搬 6 个文件（含测试），从 `events.ts` 拆出 `actions.ts`，
把 `sameTranscript` 挪进 `session.ts`。

### Task 2：`core-host` → `agent`，并入 Pi 那半 → 验证：`npm test`

`git mv` 目录与 4 个文件，改 `CoreClient` → `PiClient`、`startCore` → `startPi`。

### Task 3：`core-server` → `server` → 验证：`npm test` + `npm run test:e2e`

### Task 4：改所有引用 → 验证：全绿 + 手工起一次 GUI 和 TUI

`packages/*/package.json` 的依赖名、两个 `.cmd` 里的路径、`vite.config.ts`（若有引用）。

### Task 5：文档 → 验证：读一遍

- 第 3 节架构图：把 `core-client` 换成两层，画出 `contract` 与 `agent`
- 第 4 节目录树
- 第 5 节依赖规则的措辞
- 第 9 节接口清单里的文件路径

### Task 6：全量回归

`npm test` + `npm run test:e2e` + 起一次服务，GUI 与 TUI 各连一次。

## 执行期发现

**1. 重构把一处重复暴露了出来。** `ProviderStatus` 有两份同形状的定义——一份在
`core-host/credentials.ts`，一份在协议里。分包之前它们在同一个包里，看不出问题；
分开之后「凭据模块自己定义一个和协议一样的类型」就很刺眼了。已改成
`agent` 直接用契约里的那个：**它报告的东西就是要上线的东西，两份定义会给漂移留空间**
——而这个类型漂移的方向恰好是「不小心带上密钥」。

**2. `sameTranscript` 的归属在动手时才想清楚。** 它原本住在 `entries.ts`（折叠 Pi 的
会话条目）里，看起来属于 Pi 那侧。但它其实**只比较两个账本，一点 Pi 的东西都不碰**，
所以搬进了 `contract/session.ts`。判断依据是「它读什么」，不是「它为谁服务」。
三个相关的测试也跟着搬了，并把「重建的那一侧」从调用折叠器改成直接施加动作——
**否则契约的测试会依赖 agent，正是这次重构要消除的方向**。

**3. `sed` 又被反斜杠坑了。** 改两个 `.cmd` 里的 `packages\core-server\src\index.ts`
时 `sed -i` 静默不匹配，看起来成功、实际没改。用 Python 重做。这是同一条老问题的第 N 次。

**4. 存档条目不改写。** 文档里那些「已解决，存档」的记录保留了当时的包名——那确实是
当时的叫法，改写等于伪造历史。改为在第 8 节开头加一张对照表。

**5. `npm install` 后被拦的安装脚本仍是三个**（`@google/genai`、`esbuild`、`protobufjs`），
没有变长，符合红线。

## 实测记录

```
npm test         94 全绿
npm run test:e2e  4 全绿（真起进程的那个）
起服务 :4520     [cinba] core "IT-DES0200348"
TUI 连它          ● IT-DES0200348
浏览器连它        核心身份、会话、模型、Providers 面板都在，控制台无错
```
