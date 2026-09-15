# Web tools 实施前探针

日期：2026-09-15

范围：只读取公开文档、npm 元数据和公开搜索页面；没有读取环境变量、用户配置或真实 API key，
没有修改仓库依赖。依赖组合测试安装在系统临时目录，完成后已删除。

## 1. 搜索 Provider 契约

### Exa

官方文档：<https://exa.ai/docs/reference/search>

- `POST https://api.exa.ai/search`；
- `x-api-key` 请求头；
- 请求字段使用 `query`、`numResults`；
- 返回 `results[]`，稳定字段包括 `title`、`url`，`publishedDate` 和 `author` 可能为空；
- 普通搜索结果不保证摘要；`contents.highlights: true` 可取得适合筛选来源的短摘录。

第一版直接调用 REST，不引入 `exa-js`。请求 `type: "auto"`、用户要求的结果数和 highlights；使用
第一段非空 highlight 生成标准化 snippet，不请求完整正文，继续保持 search 与 fetch 分层。

### Brave Search

官方文档：<https://api-dashboard.search.brave.com/app/documentation/web-search>

- `GET https://api.search.brave.com/res/v1/web/search`；
- `X-Subscription-Token` 请求头；
- 查询字段使用 `q`、`count`；
- 结果位于 `web.results[]`，使用 `title`、`url`、`description`；
- 官方支持 `Api-Version` 请求头锁定兼容版本。

第一版使用普通 Web Search，不使用 LLM Context、Answers 或第三方 SDK。这样 Brave 与其他 Provider
一样只提供候选结果，不在 `web_search` 内预先抓取和综合正文。请求显式携带官方示例中的
`Api-Version: 2023-01-01`，避免默认跟随最新不兼容协议。

Brave 将 query 限制为最多 600 字符和 75 个词。公共 `web_search` 参数采用这个三家交集边界；
超限直接返回参数错误，不截断或改写用户查询。

### DuckDuckGo

没有找到供普通网页搜索使用的官方稳定 API。第一版的保底只能读取 DuckDuckGo 的公开 HTML
搜索页，因此是 best-effort adapter，不是与 Exa、Brave 等价的 API 承诺。

2026-09-15 从当前开发机各发出一次无凭据请求：

| 入口 | HTTP | 大小 | 结果结构 | challenge |
|---|---:|---:|---:|---:|
| `https://html.duckduckgo.com/html/` | 200 | 30,775 bytes | 有结果链接 | 无 |
| `https://lite.duckduckgo.com/lite/` | 200 | 22,662 bytes | 有结果链接 | 无 |

随后用 `Node.js 24 release notes` 再测 HTML 入口：HTTP 200，32,944 bytes，得到 10 个
`result__a` 和 10 个 `result__snippet`，目标 URL 包装在 `uddg` 跳转参数里。

第一版只实现 HTML 入口。若页面明确表示零结果，则返回成功空列表；若预期结构消失、出现
challenge 或无法解出目标 URL，则作为 Provider 技术失败，不能伪装成零结果。Lite 入口先保留为
调试参照，不做第二层隐式请求；真实使用证明 HTML 入口不够稳定后再决定是否增加。

## 2. HTML 处理依赖

npm 元数据与临时 ESM 组合探针确认：

| 依赖 | 选择 | Node 要求 | 类型 | 许可证 |
|---|---|---|---|---|
| `@mozilla/readability` | `^0.6.0` | `>=14` | 内置 | Apache-2.0 |
| `jsdom` | `^28.1.0` | 包含 `>=24.0.0` | `@types/jsdom@^28.0.3` | MIT |
| `turndown` | `^7.2.4` | `>=18` | `@types/turndown@^5.0.6` | MIT |

没有选择最新 `jsdom@30.0.1`，因为它要求 Node `^24.15.0`，而 Cinba 当前公开承诺是 `>=24`。
`jsdom@28.1.0` 与对应类型保持现有 Node 范围，不需要顺带提高整个产品的最低 patch 版本。

临时目录中的真实 ESM 探针完成了：

```text
HTML → JSDOM → Readability.parse() → TurndownService.turndown()
```

结果成功取得标题，把 `/docs` 转成 `https://example.com/docs`，页面内 `<script>` 没有执行。探针没有
启用 jsdom 的 script execution 或 subresource loading，退出后已关闭 window 并删除临时目录。

## 3. 对实施计划的约束

### Node 24 原生 fetch

在当前 Node 24.19 上用临时 loopback HTTP server 验证了三条实现前提：

- `redirect: "manual"` 返回原始 302，并暴露相对 `Location`，可以在跟随前解析和重新校验；
- gzip 响应头的 `Content-Length` 是 32 bytes，而读取到的自动解压正文是 12 bytes，证明两者不是
  同一个计数；下载上限必须统计实际读取的解压后 stream，不能依赖响应头；
- `AbortSignal.timeout()` 能终止尚未完成的响应，并产生 `TimeoutError`。

这些结果证明 Node 的网络原语能提供所需信号，但 `web_fetch` 不能直接采用“DNS 预检后再
`fetch`”的实现：后一次解析可能连接到不同地址，留下 DNS rebinding 窗口。Provider 的固定 API
域名继续使用 `fetch`；任意 URL 抓取改用 Node 原生 `http` / `https`、自定义受控 `lookup`、手动
redirect 与解压 stream。仍然不需要增加 HTTP client dependency。

### 已固定的实施约束

- Exa、Brave 都使用原生 `fetch`，不增加厂商 SDK；
- Exa 的 highlights 只是搜索摘要，正文仍由 `web_fetch` 获取；
- Brave 固定使用 Web Search endpoint；
- DuckDuckGo 在产品状态中标为 no-key best-effort fallback；
- query 最多 600 字符和 75 个词；
- 三个正文依赖动态导入；
- runtime dependency 与类型 dependency 使用上表兼容范围；
- Provider parser 只接受需要的字段，忽略新增字段，并用合成 fixture 锁住响应变化时的失败行为。
