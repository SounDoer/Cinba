# 基础功能：在 Cinba 里管理 provider 凭据

日期：2026-09-08
状态：已完成（2026-09-08）

兑现设计文档第 1 节的第一条动机「模型/厂商自由」的后半截：模型能切了，但**加一家新的
provider 仍然要退出去开 `pi`**。

## 这件事的性质和以往不同

前面所有功能传的都是非秘密（哪个模型、哪条对话、说了什么）。**这一件传的是密钥**，
而在此之前 **core-server 从头到尾没碰过任何 API key**——我们只把 provider 和 model 的
名字传给 Pi，Pi 自己读 `~/.pi/agent/auth.json`、自己发 HTTPS。

所以这是第 10 节那条边界线上**唯一一次主动越线**，理由是它兑现的是立项时的第一动机。
代价必须用规矩挡住，见下方「安全」。

另外它不走 RPC：**Pi 的 33 条 RPC 命令里没有 login**。走的是 `core-host` import
`ModelRuntime`，也就是第 9 节清单里的 **tier ②**（只有源码、没有协议承诺）。这是第二次
用 tier ②，第一次是 `SessionManager.list`。

## 开工前的实测（2026-09-08，全程在临时目录里做，真实 auth.json 未被触碰）

用 `PI_CODING_AGENT_DIR` 把整个配置目录重定向到临时目录，所以实验零风险。

**1. `login()` 是回调驱动的，和 Pi 自己的登录走同一条路**（抄自
`interactive-mode.js:4935`）：

```js
await runtime.login("groq", "api_key", {
  prompt: (p) => /* p = {"type":"secret","message":"Enter Groq API key"} */ theKey,
  notify: (event) => /* 进度 */,
});
```

写进 `auth.json` 的形状是 `{ "groq": { "type": "api_key", "key": "..." } }`。

**2. ⚠️ 原本担心的坑不存在：运行中的 Pi 立刻就能看到新 provider。**

```
running Pi sees: 0 models
--- login(groq) ---
running Pi now sees: 7 models (CHANGED)
```

**不需要重启任何对话**。原计划里"登录后可能要重启 Pi"那一整块可以删掉。

**3. 只读接口不含密钥，可以原样上线：**

```
listCredentials() → [{ "providerId": "groq", "type": "api_key" }]
包含密钥吗？ false
getProviderAuthStatus("groq") → { "configured": true, "source": "stored" }
```

**4. `logout(provider)` 可用**，凭据和可用模型一起清掉。

**5. 命名陷阱**：`setRuntimeApiKey()` **不落盘**——`runtime-credentials.js` 第一行注释写着
"non-persistent runtime API keys"，它相当于 `--api-key`，进程一关就没了。
**真正持久化的是 `login()`。** 照名字猜会做出"每次重启都要重输"的登录。

## 已确认的决定

| 问题 | 决定 | 理由 |
|---|---|---|
| 做到哪一步 | **只读状态 + API key 登录 + logout**，不做 OAuth | OAuth 要开浏览器等回调，Pi 那套实现围着它自己的 TUI 写；而绝大多数 provider 都是 API key |
| 凭据操作的来源 | **只接受 loopback 连接** | 今天一切都是 loopback，这条现在不生效。但形态 C 之后「你自己」会变成「任何连上来的人」，**五行代码，现在写和以后写是两回事** |
| 界面 | `/login` 选 provider → 输 key；`/logout`；`/providers` 只读 | 40 个 provider，`SelectList` 的模糊搜索扛得住 |
| 多用户 | **本次不处理** | 用户明确要求先聚焦登录。loopback 那条是唯一提前埋的东西 |

## 安全（本次新增的红线）

1. **密钥单向**：进得去，出不来。**任何 ServerMessage 都不得携带密钥**，只传
   `{ providerId, type, configured }`。
2. **不进日志、不进账本、不进快照**——账本会被广播给所有观看者，也会被写进快照。
3. **界面遮蔽输入**（网页 `type="password"`，TUI 不回显字符）。
4. **凭据操作只允许 loopback**，非 loopback 直接丢弃。
5. 权限门不受影响，本次不碰。

## 任务

### Task 1：`core-host` 增加凭据模块 → 验证：临时目录里的单元测试

新增 `packages/core-host/src/credentials.ts`：

```ts
listProviders(): Promise<ProviderStatus[]>   // { id, name, configured }，绝不含 key
setApiKey(providerId, key): Promise<void>    // 内部走 login(id, "api_key", {...})
clearCredential(providerId): Promise<void>   // logout
```

测试用 `PI_CODING_AGENT_DIR` 指向临时目录，**不碰真实凭据**：登录一个假 key、
断言列表里 `configured` 变 true、断言返回值里搜不到那个 key、logout 之后变回 false。

### Task 2：协议 + loopback 闸门 → 验证：`protocol.test.ts`

```ts
ClientMessage += | { type: "list_providers" }
                 | { type: "set_api_key"; providerId: string; apiKey: string }
                 | { type: "clear_credential"; providerId: string }

ServerMessage += | { type: "provider_listing"; providers: ProviderStatus[] }
```

`core-server` 在 `connection` 时记下 `request.socket.remoteAddress` 是不是 loopback；
`set_api_key` / `clear_credential` 只在 loopback 客户端上执行，否则丢弃并回一条 notice。

### Task 3：`core-server` 接线 → 验证：手工

三个 handler。`set_api_key` 成功后广播一次 `provider_listing`。
**不 emit 任何含密钥的 notice**，只说「provider 已配置」。

### Task 4：TUI → 验证：管道驱动

`/providers` 列状态；`/login` 选 provider → 一个不回显的输入；`/logout` 选已配置的清掉。

### Task 5：网页端 → 验证：浏览器

一个 provider 面板，`type="password"` 输入。

### Task 6：回归 + 文档 → 验证：全绿 + 更新第 9、10 节

- 第 9 节清单加 `ModelRuntime`（tier ②）一行
- 第 10 节把「登录」从「回 pi 做」移到「在 Cinba 里做」，并写明是**有条件的**
  （只 API key、只 loopback）以及为什么破例

## 执行期发现

**1. ⚠️ 真的泄漏过密钥,是被测试抓住的,不是被想到的。**

我在 `credentials.ts` 的注释里写过一句「失败信息可以显示,它永远不含密钥」——**那是假设**。
实测第一次跑 `/login` 就撞破了:

```
[could not configure: Unknown Amazon Bedrock auth method: sk-fake-key-for-testing]
```

机制很精确:Bedrock 的 `api_key` 流程**先问的是「用哪种认证方式」**,不是「输入密钥」。
而我的 `prompt` 回调对任何问题都回答密钥,于是密钥被当成方式名答了过去,
Bedrock 把它原样回显在错误里。

两层都修了:

- **回调只回答 `type === "secret"` 的问题**,别的问题直接报错并让用户去用 `pi`
- **`redactSecret()` 兜底**——任何要外传的文本先把密钥抹掉。这是防线不是主防线:
  错误信息是 40 家 provider 各自写的,不能让「某一家会不会回显」决定密钥会不会上屏

修完重跑,屏幕和服务端日志里都搜不到密钥,提示变成
`amazon-bedrock needs a sign-in this cannot do. Use "pi"`。

**教训**:安全性质写在注释里等于没写。这条本来可以一直是错的——它只是碰巧被
一次真实调用打脸了。

**2. `SelectList` 不会自己筛选,打字没反应。**
它有 `setFilter()`,但 `handleInput` 只管方向键和回车。40 个 provider 只能一个个翻——
实测时我打了 `groq`、回车,选中的还是第一项 `amazon-bedrock`。
已给 `ChoiceDialog` 加上打字收窄(会话列表 38 条也一起受益)。

**3. loopback 闸门今天挡不住任何东西,而这正是要点。**
服务只监听 `127.0.0.1`,所以每个连接都是本机的,那条检查一个都拒绝不了。
它是**为门打开的那天提前放好的**,而不是等到那天再去想起来。
`isLoopback()` 抽成了独立模块并加测试——IPv4-mapped IPv6(`::ffff:127.0.0.1`)、
整个 `127.0.0.0/8`、以及 Tailscale 的 `100.x` 必须被拒,这些形状很容易写错。

**4. 原计划担心的「登录后要重启 Pi」不存在。** 实测运行中的 Pi 立刻看到新 provider
(0 → 7 models)。那一整块设计可以删掉。

**5. 全程零风险的做法值得记下来**:`PI_CODING_AGENT_DIR` 可以把 Pi 的整个配置目录
重定向。测试、探针、手工验证全指向临时目录,**用户真实的 `auth.json` 从头到尾没被碰过**
(实测 mtime 仍是 09-06)。以后凡是要动凭据的实验都该这么做。

## 实测记录

```
TUI:  /login → 打 groq 筛选 → 输入（显示 ***） → is configured
      auth.json: { groq: { type: api_key, key: <redacted> } }
      屏幕、服务端日志里搜不到密钥
网页: Providers 面板显示 ● Groq（TUI 配的，浏览器看得到）
      Show all 40 → OpenAI → Add key（type="password"） → Save
      auth.json: { groq, openai }
真实凭据: providers ['deepseek']，mtime 09-06 —— 未触碰
```
