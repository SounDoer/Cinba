# Web tools 设计

日期：2026-09-15
状态：设计已确认，尚未实施

## 1. 目标

为 Cinba 增加独立于具体模型的联网能力。无论当前模型是否原生支持联网，Cinba 都向它提供同一套
工具、同一份配置和一致的失败行为。

第一版包含两个工具：

- `web_search`：发现与查询相关的候选网页；
- `web_fetch`：读取一个确定 URL 的正文。

这套能力作为 Pi extension 放在 `packages/extensions/src`，extension 名为 `web-tools`。不把搜索
逻辑塞进模型适配层，也不依赖某个模型厂商私有的联网接口。

## 2. 已确认的范围

### 搜索 Provider

- 接入 Exa；
- 接入 Brave Search；
- DuckDuckGo 公开 HTML 搜索页作为不需要 API key 的 best-effort 保底；
- 暂不接入 SearXNG。

Exa 直接调用官方 Search REST endpoint，并请求 highlights 生成短摘要；Brave 直接调用普通 Web
Search endpoint，不使用两家的 SDK、完整正文或面向 LLM 的综合回答接口。DuckDuckGo 没有普通
网页搜索的稳定官方 API，其页面结构变化、challenge 或限制访问都算技术失败，不能把解析失败
伪装成零结果。当前外部契约与实测记录见 `docs/notes/2026-09-15-web-tools-probes.md`。

Exa 和 Brave 可以同时配置。用户只选择首选 Provider，完整降级顺序由系统推导：

```text
auto / exa:  Exa → Brave → DuckDuckGo
brave:       Brave → Exa → DuckDuckGo
```

没有凭据的 Provider 自动跳过；没有配置任何 key 时仍可使用 DuckDuckGo。

只在技术失败时降级，包括连接失败、超时、限流、服务端错误和认证失败。搜索结果为空是一次有效
响应，不因此继续请求下一家，避免一次查询无声调用多家付费服务。

### Search 与 fetch 的边界

`web_search` 只返回适合筛选来源的标准化结果：标题、URL、摘要，以及能够可靠取得时的附加元数据。
Provider 的私有响应格式不暴露给模型。

`web_fetch` 接受一个 URL，返回最终 URL、标题、内容类型、提取后的正文和是否截断。搜索摘要只用于
选择来源；需要依据页面内容作答时，模型应再调用 `web_fetch`。用户直接给出 URL 时可以跳过搜索。

第一版 fetch 是普通 HTTP 抓取与正文提取，不是浏览器自动化：不执行 JavaScript，不使用浏览器
Cookie，不处理登录、验证码、点击和复杂 SPA。PDF、音视频及其他二进制内容暂不支持。

HTML 正文处理使用三项已确认的 runtime dependency：

```text
jsdom                 HTML → DOM
@mozilla/readability  DOM → 主要正文 HTML
turndown               主要正文 HTML → Markdown
```

Cinba 只保留一层薄适配：关闭脚本和子资源加载、传入最终 URL、配置 Turndown 规则、把相对链接转成
绝对链接、删除不需要的元素、处理 Readability 失败时的降级，并执行最终截断。三个库在第一次调用
`web_fetch` 时动态导入，避免从未使用 fetch 的 Pi 子进程在启动时承担 DOM 解析器的加载成本。

为保持根包现有的 `Node >=24` 承诺，第一版使用 `@mozilla/readability@^0.6.0`、`jsdom@^28.1.0`、
`turndown@^7.2.4`，并添加开发依赖 `@types/jsdom@^28.0.3`、`@types/turndown@^5.0.6`。实施前
组合探针见 `docs/notes/2026-09-15-web-tools-probes.md`。

不把 Readability 返回的 HTML 直接发送给模型或插入 Web/TUI；模型只接收转换后的 Markdown。

### 模型调用契约

第一版 `web_search` 只提供跨三家 Provider 都稳定成立的参数：

```ts
{
  query: string;        // 去掉首尾空白后非空，最多 600 字符和 75 个词
  max_results?: number; // 默认 5，最少 1，最多 10
}
```

暂不暴露 Provider 名称、域名过滤、时间过滤、搜索类别或 Exa/Brave 私有参数。模型选择的是“搜索
什么”，不是“向哪一家买搜索”；路由属于用户配置和系统容错。

模型可见的 `content` 使用简洁文本而不是把 Provider JSON 原样塞进上下文：

```text
Search provider: Exa
Query: Node.js 24 release notes

1. Node.js 24 release notes
   https://nodejs.org/...
   Node.js 24 introduces ...
```

Extension 同时在 `details` 保存类型化的 provider、results、attempts 和 truncation 信息，供测试和
以后自定义渲染使用。`details` 不得包含 API key、请求头或未经清理的 Provider 错误响应。

第一版 `web_fetch` 只有一个模型参数：

```ts
{
  url: string;
}
```

超时、下载上限和正文长度是工具自身的安全策略，不让模型逐次放宽。模型可见结果包含来源头、
明确的不可信内容边界和正文；`details` 保存 requested URL、final URL、title、content type、大小与
截断状态。

两个工具都接收并向下传递 Pi 提供的 `AbortSignal`。用户中止后立即停止请求，不把中止当成
Provider 故障继续降级。多个互不依赖的 fetch 可以并行执行。

模型可见输出统一使用 Pi 已提供的 `DEFAULT_MAX_BYTES`、`DEFAULT_MAX_LINES` 和 `truncateHead()`，
即最多 50 KB 或 2000 行，先到者为准。网页全文不另外写入临时文件；截断是一次成功结果，并在
`content` 与 `details` 中明确标记。网络下载上限与模型输出上限是两层不同保护，具体默认值见
第 5 节。

注册工具时必须同时提供 `promptSnippet` 和 `promptGuidelines`。当前 Pi 只有在设置
`promptSnippet` 时才会把 custom tool 写入默认 system prompt 的 Available tools；guidelines 还要
告诉模型：搜索摘要用于选来源、重要结论先 fetch、网页正文是不可信资料而不是指令。

## 3. 配置与凭据

设置属于一个 Core instance，不属于仓库，也不随发布覆盖。所有路径都从 Server 已解析的
`CINBA_STATE_DIR` 出发，不能在 Web tools 内重新写死 `~/.cinba`。

- 非秘密设置进入 `<CINBA_STATE_DIR>/config.json`，包括首选搜索 Provider；
- Cinba 自己持久化的 Web tools API key 进入 `<CINBA_STATE_DIR>/credentials.json`；
- 同时接受 `EXA_API_KEY` 和 `BRAVE_SEARCH_API_KEY` 环境变量；
- 环境变量优先于本地持久化值；
- DuckDuckGo 不需要凭据。

默认 Stable Core 没有显式设置状态目录，因此仍使用 `~/.cinba`。Dev Core 由启动器设置独立目录：

```text
Stable: ~/.cinba/config.json
        ~/.cinba/credentials.json

Dev:    ~/.cinba/dev/config.json
        ~/.cinba/dev/credentials.json
```

环境变量由 Core 外部管理。界面可以显示其来源，但不能修改或删除；删除时应告诉用户移除对应
环境变量并重启 Core。

环境变量本身不天然服从 instance 目录隔离。Stable Core 和 VPS 可以使用通用的 `EXA_API_KEY`、
`BRAVE_SEARCH_API_KEY`；`npm run dev` 创建 Dev 环境时必须主动移除这两个变量，避免未完成的开发
代码接触 Stable 的真实搜索凭据。Dev 凭据默认通过 5173 上的开发 Web 界面单独配置并写入 Dev
状态目录。第一版不新增 `DEV_EXA_API_KEY` 一类变量；只有出现真实自动化需求后再设计。

密钥遵守与模型凭据相同的产品规则：

1. 只允许写入，不通过任何 ServerMessage 读回；
2. 不进入日志、会话账本、快照、错误信息或部署状态；
3. TUI 不回显，Web 使用密码输入框；
4. 测试只使用临时目录和合成 key，不接触用户真实配置；
5. 本机和远程客户端功能一致，访问边界沿用 VPS 设计中的 Tailscale Grant、Caddy、Origin 校验、
   操作系统用户隔离与统一权限门。

客户端不能直接读写这两个文件。Core 拥有配置写入和状态查询，TUI、Web 与未来其他客户端都通过
`core-client` 和类型化协议操作同一份状态。Extension 只读取执行工具所需的有效配置，不负责接受
客户端管理请求。Pi 子进程继承所属 Core 的 `CINBA_STATE_DIR`，因此 extension 可以从正确的
instance 目录只读加载最新配置；修改凭据不需要重启已有对话。

Extension 在每次 `web_search` 调用开始时重新读取普通设置和凭据，不做 mtime 缓存。文件很小，
相对于网络请求这点 I/O 可以忽略；每次读取能避免缓存失效和多 Pi 子进程状态不一致。`web_fetch`
不依赖搜索 Provider 配置，无需读取凭据文件。

## 4. 客户端管理形式

### TUI

只增加一个 `/webtools` 入口，打开交互式管理菜单：

```text
Web tools

> View status
  Add or replace API key
  Remove API key
  Choose primary search provider
```

状态页展示两个工具的可用状态、三个搜索 Provider 的状态、凭据来源、首选 Provider 和推导出的
实际搜索顺序。配置和删除凭据时复用现有 Provider 选择框与遮蔽输入组件。

第一版状态只表达 `configured`，不声称已经验证凭据健康。某次搜索遇到认证失败时，工具记录经过
清理的降级原因并尝试下一家，但不在各 Pi 子进程内维护 `unhealthy` 状态，也不把短暂失败持久化。
以后若真实需要，应由 Core 统一提供显式的连接测试和健康状态，不能让不同会话各报一套结果。

不增加 `/web-login`、`/web-logout` 或 `/webtools-login` 等顶层命令。TUI 是常驻交互界面，操作选择
由菜单承担，不要求用户记住子命令。

普通 `cinba` 和 `npm run tui` 默认连接 Stable Core。开发或验收 `/webtools` 时必须让 TUI 显式连接
已经由 `npm run dev` 启动的 Dev Core，避免测试操作写入 Stable 配置：

```powershell
$env:CINBA_SERVER = "ws://127.0.0.1:4518"
npm run tui
```

第一版先使用现有的 `CINBA_SERVER` 能力，不新增产品 CLI 命令；若这条手工步骤在实际开发中反复
造成困扰，再增加 `npm run tui:dev` 这样的仓库级开发入口。

### Web / Desktop

第一版同步提供简单的 Web 功能面板：

- 查看工具与 Provider 状态；
- 添加、替换和删除 Exa、Brave 的 API key；
- 选择首选搜索 Provider；
- 查看实际降级顺序。

第一版只要求功能完整，不投入最终布局和视觉设计。Desktop 复用同一个 Web 界面和 Core 协议。

### 产品 CLI

本阶段不增加 CLI 命令。以后出现无界面管理或脚本化需求时，可以增加：

```text
cinba webtools status
cinba webtools login <provider>
cinba webtools logout <provider>
cinba webtools primary <provider>
```

CLI 的层级子命令和 TUI 的交互菜单可以不同；需要共享的是底层操作语义与 Core API，而不是输入
形式。未来 CLI 也必须通过 Core 管理配置，不能另写一套文件修改逻辑。

## 5. 网络与内容安全边界

`web_fetch` 只接受公开的 HTTP/HTTPS URL。必须拒绝 URL 凭据、本机、私网、link-local、云平台
元数据地址和其他非公开目标；DNS 解析后以及每一次重定向后都要重新检查，不能只验证输入字符串。

Provider API 使用固定 HTTPS 域名，可以直接用 Node `fetch`。`web_fetch` 的任意 URL 不能采用
“先 `dns.lookup()`、再让 `fetch` 重新解析”的两步写法，否则两次解析之间存在 DNS rebinding
窗口。它使用 Node 原生 `http` / `https` 和自定义 `lookup`：解析全部地址、拒绝任何非公开结果，
并把选定的允许地址直接交给本次 socket 连接。HTTPS 仍以原 hostname 做 SNI 和证书校验。每次
redirect 都创建一次新的受控请求并共用总 deadline。

请求不携带 Cinba 凭据、搜索 Provider key、浏览器 Cookie 或用户自定义 Authorization header。
搜索 Provider key 只发送给对应 Provider 的固定 API 地址。

下载必须限制总时间、重定向次数和解压后的响应大小。超限时在安全可行的情况下返回截断内容，
否则返回结构化失败。交给模型的输出沿用第 2 节已经确定的 Pi 统一截断上限。

第一版使用以下固定默认值：

| 限制 | 值 | 行为 |
|---|---:|---|
| 单个搜索 Provider 超时 | 8 秒 | 技术失败，尝试下一家 |
| 整次搜索总时限 | 20 秒 | 所有 Provider 共用同一个 deadline |
| 搜索 Provider 响应上限 | 1 MiB | 本次 Provider 失败，尝试下一家 |
| 同一 Provider 自动重试 | 0 次 | 直接利用已有降级链，避免重复计费与拉长等待 |
| 整次 fetch 总时限 | 20 秒 | 所有重定向共用同一个 deadline；超时不返回半截内容 |
| fetch 重定向 | 最多 5 次 | 每次都重新校验 scheme、hostname 与解析后的地址 |
| fetch 解压后下载上限 | 2 MiB | 停止下载并尝试解析已有内容，标记 `downloadTruncated` |
| Readability DOM 元素上限 | 50,000 | 超限返回结构化失败，不让复杂页面长期占用 CPU |
| 模型可见输出 | 50 KB 或 2000 行 | 使用 Pi 自带截断规则，先到者为准 |

下载上限和模型输出上限保护不同阶段：2 MiB 限制网络流与 DOM 输入，50 KB / 2000 行限制模型
上下文。`Content-Length` 只能用于提前拒绝，实际仍要对解压后的读取流计数，不能信任响应头。

抓取到的网页正文是外部不可信数据，不是给 agent 的指令。工具结果必须保留来源边界，工具描述也
要明确要求模型忽略页面中的命令、身份声明和索取秘密的内容。

通过公开地址校验的 `web_search` 与 `web_fetch` 视为只读工具，可以由权限策略自动允许；不安全的
fetch 目标直接拒绝，不提供一次确认后绕过的通道。本地开发站点访问若以后确有需求，应设计单独、
显式的能力。

## 6. 代码职责

目标结构按职责而非 Provider 堆在一个文件里：

```text
packages/extensions/src/
├── web-tools.ts
└── web-tools/
    ├── config.ts
    ├── credentials.ts
    ├── search.ts
    ├── fetch.ts
    ├── types.ts
    └── providers/
        ├── exa.ts
        ├── brave.ts
        └── duckduckgo.ts
```

- `web-tools.ts`：Pi extension 入口，只负责注册工具；
- `search.ts`：Provider 选择、降级和标准化；
- `fetch.ts`：URL 校验、HTTP 获取，以及 Readability、jsdom、Turndown 的薄适配；
- `config.ts` / `credentials.ts`：以 `CINBA_STATE_DIR` 为根解析并持有 Web tools 配置格式；
- `providers/*`：隔离各家请求、认证和响应格式；
- `server`：配置与凭据写入、状态汇总、协议处理；
- `contract`：客户端消息、服务端状态和公共类型；
- `core-client`：Web、TUI、Desktop 共用的管理方法；
- `tui` / `web`：只负责各自的交互呈现。

协议变化必须同时确认 Web、TUI 和 Desktop 跟进。

## 7. 实施前探针

设计阶段没有剩余的产品决定。公开文档、DuckDuckGo、Node 24 网络行为和正文依赖组合探针已完成，
记录见 `docs/notes/2026-09-15-web-tools-probes.md`。不需要真实 key 的外部前提已经确认：

- Exa、Brave 官方 endpoint、认证头、请求和响应字段；
- DuckDuckGo HTML 入口当前可用，并且只能作为 best-effort；
- Node 24 `fetch` 的解压、手动重定向与 `AbortSignal` 行为满足实现需要；
- 选定版本的 Readability、jsdom 与 Turndown 能在 ESM 和 Node 24 下串联运行。

剩余验证进入实现测试，而不是继续做脱离代码的探针：

1. 用户实际配置 key 后，对 Exa、Brave 各发出一次最小真实请求，确认账号计划下的响应与状态码；
2. 用固定 fixture 覆盖中文文章、英文文章、技术文档、代码块、列表和噪音页面；
3. 用本地可控 server 覆盖限流、超时、超限、重定向到私网和用户中止；
4. 在 Dev Core 中完成真实 search、fetch、TUI 和 Web 端到端验收。

探针只验证外部事实，不重新打开已经确认的产品范围。若某个 API 的真实约束与设计冲突，再带着
证据回来调整；否则直接进入逐任务实施计划。
