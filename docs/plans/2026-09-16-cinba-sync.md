# Cinba Sync 实施计划

日期：2026-09-16  
状态：待实施  
对应设计：`docs/specs/2026-09-16-cinba-sync-design.md`

## 目标与完成标准

把各台 Core 分别维护 model、Web tools 和 API key 的现状，改造成可选的单用户自托管同步能力：

- 未连接 Sync 的 Core 继续以 Local 模式独立工作；
- Windows、Mac 和 VPS Core 可共享一份 Shared Settings 与普通 API-key Credentials；
- Dev Core 默认使用 Shared Settings，但只读取自己的 Local Credentials；
- 每个 Core 保留 Instance Override，当前会话选模型不反向修改 Shared Settings；
- Sync Server 可部署在 VPS、Mac 或其它常驻设备，不依赖普通 Core 才能运行；
- Sync Web 是唯一完整管理界面，Desktop 不复制它的地址配置或管理入口；
- Sync 离线时 Core 使用最后一次成功同步的缓存，不阻塞启动和已有工作；
- Core 注册、撤销、设置冲突、历史回滚、备份恢复和敏感数据边界均有自动测试；
- 用真实 Windows、Mac、VPS 与 Dev Core 完成端到端验收；
- `npm run check` 完整通过。

第一版不做多个 Shared Settings、多用户、同 Provider 多份 Credential、OAuth 同步、外部 secret
manager、WebSocket push、HA、离线编辑共享设置、自动配置迁移、完整管理 TUI、原生移动 App或托管云。

## 实施原则

1. 先做只改变内部结构、不改变 Local 行为的重构，再引入网络同步。
2. 协议、存储、加密与合并规则优先写成纯模块；HTTP、Electron 和真实进程只是适配层。
3. Sync Server 与 Core Server 是两个独立进程，禁止互相导入业务实现。
4. 所有客户端经过各自 client package：Core 客户端用 `@cinba/core-client`，Sync 管理端和 Core
   同步端用 `@cinba/sync-client`。
5. Secret 只能出现在明确的敏感存储和 Core Snapshot 内存路径中；列表、日志、错误、历史和管理
   API 响应只返回 redacted 状态。
6. 损坏或未知版本的状态文件 fail closed，保留原文件，绝不自动覆盖成空状态。
7. 每个阶段先运行相关 package 的测试与 typecheck；形成跨 package 纵切后再运行全量 merge gate。
8. 不自动迁移现有配置。实现切换时由用户重新配置；代码仍需避免删除或改写旧文件。
9. 优先使用 Node 24、现有 React/Vite 与仓库已有依赖。若需要新增 runtime dependency，先停止并
   征得用户同意。
10. 每个阶段形成独立、可回滚的 Conventional Commit，不用一个巨型提交同时改协议、服务、UI 和
    部署。

## 预期文件形状

具体文件名可在实现时小幅调整，但 package 边界和依赖方向不变：

```text
packages/
├── sync-contract/
│   ├── package.json
│   └── src/
│       ├── index.ts
│       ├── schemas.ts              # 严格解析与版本
│       ├── management.ts           # 管理 API 类型
│       ├── core.ts                 # enrollment、snapshot、capabilities
│       └── errors.ts
├── sync-client/
│   ├── package.json
│   └── src/
│       ├── index.ts
│       ├── http.ts                 # timeout、JSON、错误与 no-store
│       ├── management-client.ts
│       └── core-sync-client.ts
├── sync-server/
│   ├── package.json
│   └── src/
│       ├── index.ts
│       ├── server.ts
│       ├── config.ts
│       ├── store/
│       │   ├── schema.ts
│       │   ├── sync-store.ts
│       │   └── atomic-json-store.ts
│       ├── security/
│       │   ├── credentials.ts
│       │   ├── password.ts
│       │   ├── sessions.ts
│       │   └── csrf.ts
│       ├── services/
│       │   ├── setup-service.ts
│       │   ├── settings-service.ts
│       │   ├── credential-service.ts
│       │   ├── enrollment-service.ts
│       │   ├── snapshot-service.ts
│       │   └── backup-service.ts
│       └── routes/
│           ├── management-routes.ts
│           └── core-routes.ts
├── sync-web/
│   ├── package.json
│   └── src/
│       ├── app.tsx
│       ├── use-sync.ts
│       ├── setup.tsx
│       ├── login.tsx
│       ├── overview.tsx
│       ├── shared-settings.tsx
│       ├── credentials.tsx
│       ├── connected-cores.tsx
│       ├── history.tsx
│       └── backup.tsx
├── server/src/
│   ├── config.ts                   # 仅本机事实和兼容入口
│   ├── effective-settings.ts
│   ├── instance-override.ts
│   ├── local-settings.ts
│   ├── runtime-credentials.ts
│   └── sync/
│       ├── connection-store.ts
│       ├── snapshot-cache.ts
│       ├── coordinator.ts
│       └── scheduler.ts
├── agent/src/
│   └── provider-environment.ts
├── contract/src/
│   └── sync.ts                     # 只描述当前 Core 的 Sync 控制面
├── web/src/
│   └── sync-settings.tsx
├── tui/src/
│   └── sync-flow.ts
└── desktop/src/                    # 只保留 CoreProfile 与 Core 导航

scripts/
├── cinba.ts                        # sync serve/status/reset/backup/restore
└── launch.ts                       # 开发入口，不接入 Core idle lifecycle

packages/deploy/
└── src/                            # Sync 独立服务安装与诊断
```

Core 的状态目录预计分为以下职责。最终文件名由阶段 1 的纯模型测试固定：

```text
<CINBA_STATE_DIR>/
├── config.json                     # cwd、coreName、lastSessionId 等本机事实
├── local-settings.json             # Local 模式的 Shared Settings 等价物
├── instance-override.json          # 仅此 Core 的覆盖
├── credentials.json                # Local Credentials
├── sync-connection.json            # URL、Core id、Core credential、source mode
└── sync-cache.json                 # last-known-good Snapshot，可能含 Shared Credentials
```

这些文件均使用原子替换。含 secret 的三个文件使用私有权限；Windows 依赖用户目录 ACL，不声称
POSIX mode 是 Windows 的安全边界。

## 阶段 0：关键技术探针

### 目的

先验证三处会决定实现形状的底层事实，不在正式 package 里边做边猜：

1. 当前 Pi RPC 子进程支持哪些 API-key Provider、环境变量名和认证优先级；运行中的会话是否能
   安全更新 key，还是只能让新 Pi 进程生效；
2. Electron 当前 `BaseWindow` / `WebContentsView` 结构能否安全承载另一个 HTTPS origin，cookie
   是否按 Sync origin 隔离，以及导航、下载和新窗口该如何拦截；
3. Node 24 在 Windows、macOS、Linux 上的原子 rename、文件权限、`scrypt`、AEAD 和敏感临时文件
   行为。

### 产物

新增 `docs/notes/2026-09-16-cinba-sync-probes.md`，记录实际代码或最小实验、结论与对后续阶段的
约束。临时实验不进入产品代码。

### 完成条件

- Provider 到环境变量的映射有可引用的权威来源或当前依赖源码证据；
- Desktop 的嵌入方案和外部浏览器降级方案已明确；
- 三个平台的文件与加密实现没有依赖不存在的 POSIX 假设；
- 若探针要求新增 runtime dependency，在继续实施前先与用户确认。

## 阶段 1：拆开本机状态、设置来源与有效配置

### 改动

在 `packages/server` 中把当前 `config.ts` 同时承担的职责拆开：

- Local State：`cwd`、`coreName`、`lastSessionId`；
- Local Settings：未连接 Sync 时的 `defaultModel` 与 `webTools.searchPrimary`；
- Instance Override：字段级可选，只属于当前 Core；
- Source Selection：Settings 使用 Local/Sync，Credentials 使用 Local/Sync；
- Effective Settings：按“显式创建参数 → Instance Override → Shared/Local Settings → Pi 默认”解析；
- Runtime Credentials：只向具体消费者返回所需 Provider 的 key，不向 UI 返回明文集合。

本阶段不请求网络、不增加 Sync UI。现有 `model` 和 `webSearchPrimary` 行为改由新解析器提供，Web、
TUI 和 Desktop 的可见体验保持不变。旧文件不自动迁移也不删除；测试使用全新临时目录固定新形状。

`packages/extensions/src/web-tools/configuration.ts` 暂时保留兼容适配，但先让它可以消费 Core 生成的
明确运行配置，为阶段 8 移除独立来源判断做准备。

### 测试

- Local/Local 缺省行为与当前 Core 一致；
- Local Settings、Override 和会话显式模型的字段级优先级；
- Reset override 后立即恢复跟随 Local Settings；
- 修改会话模型不写任何 Settings 文件；
- 本机状态更新不会重写 Credential 或 Settings；
- 损坏 JSON 保留原文并拒绝覆盖；
- 所有原子写测试只使用临时目录，不触碰真实用户配置。

### 完成条件

尚未连接 Sync 时，现有功能与启动路径全部通过；后续 Sync 只需替换 Shared Settings 和 Credential
的来源，不再侵入会话状态。

## 阶段 2：Sync 协议与 HTTP Client 底座

### 改动

建立 `@cinba/sync-contract` 和 `@cinba/sync-client`：

- 为 Shared Settings、Instance capabilities、Credential status、Connected Core、enrollment、
  Snapshot、history、backup metadata 和错误响应定义 versioned 类型；
- 所有网络输入在边界做严格运行时解析，未知 schema version 明确失败；
- 管理端和 Core 端的认证类型分开，类型层面不能互换；
- URL 只接受规范化的 `https:` 根地址；仅测试和显式 loopback 开发模式允许 `http:`；
- HTTP client 统一 timeout、AbortSignal、JSON content type、响应大小上限和结构化错误；
- Snapshot 支持 ETag/`If-None-Match` 或等价 revision 条件请求；
- 敏感响应强制检查 `Cache-Control: no-store`，错误对象不包含请求 header 或响应明文。

协议先固定最小 API 面，不让 UI 直接拼 URL。建议路由分区：

```text
/api/management/*   管理员 cookie + CSRF
/api/core/*         单 Core bearer credential
/health             无 secret 的健康状态
```

### 测试

- 每类 request/response 的合法、缺字段、额外敏感字段和未知版本；
- 管理 credential 不能传入 Core client，反之亦然；
- 非 HTTPS remote、带 userinfo/query/fragment/子路径的地址被拒绝；
- timeout、abort、非 JSON、超大响应和结构化错误；
- client 从不把 Authorization、Cookie、API key 写进错误或调试输出；
- conditional snapshot 的 unchanged 分支不解析或覆盖本地缓存。

### 完成条件

协议和 client 可由 fixture HTTP server 完整测试，不依赖 Sync Server、Core 或浏览器。

## 阶段 3：Sync Store、Revision 与 Credential 加密

### 改动

建立 `@cinba/sync-server` 的纯存储层，暂不开放 HTTP：

- `~/.cinba-sync/state.json` 保存 schema version、稳定 server identity、Shared Settings、
  `settingsRevision`、历史、`syncRevision`、加密 Credential、Core registry、pending enrollment 和
  管理员验证信息；
- `credential-key` 首次安装自动生成，与 `state.json` 分离；
- 使用 Node 内置 AEAD，envelope 显式保存 version、随机 nonce、authentication tag 和 ciphertext；
- `SyncStore` 用进程内队列串行化 mutation，完整临时文件写入、刷新、重新解析后原子替换；
- Shared Settings 更新与回滚同时递增两个 revision；Credential 更新只递增 `syncRevision`；
- Settings 更新必须携带 `baseSettingsRevision`，不匹配时返回 conflict；
- Core token 只保存带随机 salt 的 hash，原 token 只在批准时返回一次；
- history 不保存 Credential 明文、密文副本或管理员 session。

读到未知 schema、截断 JSON、AEAD 验证失败或缺失 key 时进入只读错误状态，任何普通写操作都不能
把它“修好”为新空文件。

### 测试

- 首次初始化和重启读取保持 server identity；
- 并发 mutation 严格串行且 revision 连续；
- stale settingsRevision 被拒绝，当前数据不变；
- Settings 更新、Credential 更新与历史回滚的两个 revision 语义；
- 同一明文每次加密结果不同，篡改 nonce/tag/ciphertext 均无法解密；
- `state.json` 单独复制后不能得到明文 key；
- token hash 可验证但不能读取原 token；
- 写入中断保留旧完整文件，不遗留可被误读的临时状态；
- 损坏状态、未知版本和丢失 key 均 fail closed。

### 完成条件

所有权威状态变更都只能经过 `SyncStore`，上层 service 不直接读写 JSON 或 `credential-key`。

## 阶段 4：管理员 Setup、登录与安全 Session

### 改动

在 Sync Server 中实现单用户管理员身份：

- 首次启动生成高熵一次性 Setup Code，只在本机控制台或 `cinba sync status` 的受控输出中出现；
- Setup Code 验证后设置管理员密码并永久作废；
- 密码使用 Node `scrypt`、独立随机 salt 和版本化参数保存；
- 登录成功生成仅内存 session，重启后需要重新登录；
- cookie 使用 `HttpOnly`、`Secure`、严格 SameSite 与受限 path；显式 loopback 开发模式单独处理
  Secure cookie，不把例外带入部署模式；
- 所有写管理 API 同时验证 session、Origin 和 CSRF token；
- 登录和 Setup 尝试有内存级速率限制，不把输入值写日志；
- `reset-password` 只能从 Sync Server 主机本地命令执行，使旧 session 失效并生成新 Setup Code。

### 测试

- Setup Code 只可成功使用一次，重启后不能复活；
- 密码从不明文落盘，同一密码的 salt/hash 不固定；
- 正确/错误登录、登出、过期和服务重启；
- 缺 Cookie、缺 CSRF、错误 Origin、跨站表单和重放被拒绝；
- reset 使现有 session 和旧密码失效；
- 日志、错误响应和测试 snapshot 不出现 Setup Code、密码或 session id。

### 完成条件

管理 API 可以安全区分未初始化、未登录和已登录状态；尚不需要任何管理页面。

## 阶段 5：Enrollment、Capabilities、Snapshot 与管理 API

### 改动

在已验证的 Store 与认证之上实现 service 和 HTTP routes：

- Core 创建 pending enrollment，提交显示名称、平台、版本和 Credential source；
- 管理员 Approve/Reject；Approve 只返回一次 Core credential；
- 等待批准使用短时有限轮询，完成、拒绝或超时后停止；
- 每个已批准 Core 可上报非敏感 capabilities、模型目录摘要、版本和最后同步状态；
- 管理端据此提供跨 Core 模型选择候选，并清楚标记“并非所有 Core 都支持”；
- Core 只能读取 Snapshot、上报自己的 capabilities/status，不能读取 Core 列表或修改设置；
- `credentialSource: local` 的 Core Snapshot 永不包含 Shared Credentials；
- Revoke 单个 Core 后其 credential 立即不能再取得新 Snapshot；
- Shared Settings、Credentials、Connected Cores、history 和 rollback 暴露给管理 API；
- Credential GET 只返回 `{ provider, configured }` 等 redacted 信息；覆盖和删除后发布新
  `syncRevision`；
- Snapshot 和 Credential 相关响应带 `Cache-Control: no-store`，访问日志只记录 route、status 和
  request id。

### 测试

- pending → approved/rejected/expired 的完整状态机和一次性 credential 返回；
- 两个 Core credential 互不通用，revoke A 不影响 B；
- Local Credential Core 无法通过改请求参数取得 Shared Credentials；
- Core route 无法调用任何 management mutation；
- capabilities 不接受 secret 字段、异常尺寸或伪造另一 Core id；
- Settings conflict、history 与 rollback；
- Credential 创建、替换、删除只在 Snapshot 内按授权出现，管理响应始终 redacted；
- conditional Snapshot 在 revision 不变时返回 unchanged；
- 所有敏感响应和失败路径验证 no-store 与日志脱敏。

### 完成条件

不用 UI，只通过 `@cinba/sync-client` 的集成测试即可完成 Setup、登录、注册、配置、同步、撤销和回滚。

## 阶段 6：响应式 Sync Web

### 改动

建立 `@cinba/sync-web`，由 Sync Server 同 origin 提供静态资源和 API：

- Setup / Login：初始化和管理员登录；
- Overview：server identity、当前 revision、Connected Core 与最近同步异常；
- Shared Settings：default model、Web Search primary 和来源说明；
- Credentials：按 Provider 显示 configured 状态，只允许 replace/delete，不提供 reveal；
- Connected Cores：pending approve/reject、已连接详情与 revoke；
- History：Settings revision、差异摘要与 rollback；
- Backup / Restore：导出敏感性提示、恢复前检查和只读切换说明。

default model 的候选来自 Core capability reports 的并集，显示哪些 Core 支持。仍允许手工输入合法
`provider/id`，以便当前没有在线 Core；保存前提示而不是错误声称 Sync Server 能自行枚举 Pi 模型。

页面读取 Settings 时保留 `settingsRevision`；保存冲突后展示“内容已被另一页面更新”，要求刷新，不做
客户端静默覆盖。移动端宽度必须可完成全部管理操作。

### 测试与验收

- 未初始化、未登录、已登录和 session 失效路由；
- 两个页面基于同 revision 编辑时，后保存者得到可理解的 conflict；
- Credential 输入提交后立即从 DOM/state 清除，页面和响应不回显旧值；
- pending approve、revoke、history rollback 与错误恢复；
- capability 并集、部分 Core 支持、无在线 Core 的模型选择；
- 键盘操作、focus、窄屏布局和基本无障碍检查；
- production build 后由 Sync Server 正确提供 SPA fallback 与静态缓存策略，API 不被缓存。

### 完成条件

Mac、Windows 和手机浏览器可以管理同一台无桌面 VPS Sync Server，不需要 SSH TUI 完成日常操作。

## 阶段 7：Core 连接、缓存与同步协调器

### 改动

在 `packages/server/src/sync/` 实现：

- connection store：Sync URL、Core id、Core credential、Settings/Credential source；
- enrollment coordinator：发起、等待、取消和保存批准结果；
- snapshot cache：原子保存完整 last-known-good Snapshot；
- coordinator：条件拉取、严格校验、提交缓存后再切换内存有效值；
- scheduler：Core 启动时同步、低频带 jitter 轮询、手动 `Sync now`，同一时刻最多一个请求；
- status model：disconnected/pending/online/stale/error/revoked，以及 last success、revision 和可操作
  错误；
- capabilities reporter：从当前 Core 获取非 secret provider/model 能力并在变化时上报。

网络失败、Server 离线或 Snapshot 非法时保留旧缓存。首次连接尚无缓存时，Settings 可明确回退
Local；若选择 Shared Credentials 而无缓存，则需要该 key 的操作给出缺凭据错误，不能偷偷改读 Local
key。Dev 默认连接参数为 Settings Sync、Credentials Local。

Disconnect 只删除连接 credential 和同步缓存，不删除 Local Settings、Local Credentials、sessions 或
Instance Override；这一行为在 UI 中明确提示。

### 测试

- 首次连接、批准、重启后自动认证；
- 启动同步、jitter 轮询与手动同步合并并发请求；
- unchanged revision 不重写缓存或广播无意义更新；
- 写缓存失败时旧内存与旧文件继续生效；
- 离线启动使用 last-known-good，状态为 stale 而不是 disconnected；
- malformed/降级/未知版本 Snapshot 不替换好缓存；
- Shared Credentials 模式和 Local Credentials 模式取得不同 Snapshot；
- revoked 后停止重试认证风暴并给出重新连接动作；
- Dev launcher 的默认来源以及 Dev 缓存中绝不出现 Shared Credentials；
- Disconnect 的精确删除边界。

### 完成条件

通过假的 Sync client 可证明 Core 生命周期和离线语义；Sync Server 暂时停止时 Core 仍能启动并使用
已有缓存。

## 阶段 8：把 Effective Settings 与 Credentials 接入真实消费者

### 改动

这是风险最高的纵切，按阶段 0 的探针结果实施：

- `packages/agent` 新增集中式 Provider environment 映射与校验，只接受 Core 已解析的目标 Provider
  credential；
- `pi-process.ts` 启动新 Pi 子进程时注入需要的环境变量，不经命令行参数，不把 key 写日志；
- key 更新只影响随后创建的 Pi 进程，不强制中断正在运行的会话；
- Pi `auth.json` 的 OAuth/subscription entry 保持本地；Shared default 需要本机 OAuth 但未登录时，
  报告 local provider login required；
- 同步模式发现会与 Shared API key 竞争的本地 API-key auth entry 时，显示冲突而不静默决定优先级；
- `packages/extensions` 改为消费 Core 写出的有效 Web tools 运行配置，不再自己判断 Local/Sync/环境变量
  优先级；
- `defaultModel` 只用于新会话；当前会话切换继续由现有 session action 管理；
- `webTools.searchPrimary` 更新在下一次搜索时生效。

有效运行配置若必须落盘给 extension 读取，文件只包含当前 Core 需要的数据、使用私有权限和原子替换，
并与 Sync 原始 Snapshot 分开。不要建立第二套合并算法。

### 测试

- Local 与 Sync key 分别注入正确 Provider，未选 Provider 的 key 不进入子进程环境；
- key、环境变量映射和 auth 冲突不会出现在日志或错误；
- 更新 Shared key 后新 Pi 进程获得新值，既有进程不被杀死；
- Shared default model 仅影响新会话；会话选择不写 Sync 或 Override；
- Override model 覆盖 Shared，Reset 后恢复跟随；
- OAuth 已登录/未登录与 API-key Provider 的错误分类；
- Web Search primary 与 Exa/Brave key 在 Local、Sync、Dev 三种组合下正确；
- Dev 即使父进程或 Sync Snapshot 有生产 key，也不能传入 Dev Pi 或 Web tools；
- 真实 Pi RPC smoke test 验证至少一个普通 model Provider 和一个 Web Search Provider。

### 完成条件

Windows、Mac、VPS 的新会话实际使用相同 Shared default/key，Dev 实际只能使用本地 key；敏感值未
进入命令行、日志、协议状态或测试快照。

## 阶段 9：当前 Core 的 Contract、Core Client、Web 与 TUI

### 改动

扩展 `@cinba/contract`，只加入当前 Core 的控制面：

- 查询 Sync status、source mode、有效 revision 与最近错误；
- Connect / cancel enrollment / Disconnect；
- `Sync now`；
- 读取和更新 Instance Override；
- 修改 Settings/Credential source 的受限组合；
- 获取安全的 Sync management URL。

`@cinba/core-client` 封装这些操作，Web、TUI 和 Desktop 不直接访问 Core route。Web 与 TUI 提供同一
能力语义：状态、连接、手动同步、来源选择、Override、Reset to shared，以及打开/显示管理地址。
它们不保存管理员密码、不代理 Shared Settings 或 Credential mutation。

任何 `packages/contract` 改动必须在同一阶段确认 Web、TUI、Desktop 全部编译和行为一致。

### 测试

- protocol parser、权限状态和错误映射；
- Core client 的每个操作、timeout 和断线恢复；
- Web/TUI 的 Local、pending、online、stale、revoked 状态；
- 不允许 `Local Settings + Shared Credentials`；Dev 的默认组合表达正确；
- Override 的 shared/effective/source 展示和 Reset；
- `Sync now` 有进行中防重复状态；
- current Core UI 中不存在管理员 Credential 写入入口；
- Desktop 对新增 Core contract 的构建兼容检查。

### 完成条件

用户在任意 Core 的 Web/TUI 能看清“值从哪里来”、连接 Sync 和排查当前 Core，但完整管理仍只有
Sync Web。

## 阶段 10：Desktop 中的 Sync 管理导航

### 改动

保留现有 `CoreProfileStore` 和 Core 切换模型。实机试用发现，再让 Desktop 单独保存一次
Sync URL 会造成重复配置，并让用户误以为该表单会把 Core 连接到 Sync。因此最终实现改为：

```text
Desktop
├── Cores
│   ├── Local Core
│   └── Remote Core
```

Desktop 不保存 Sync Server URL、管理员密码、session 或 Core credential。当前 Core 的 Sync
面板是唯一入口；它使用该 Core 已保存的 management URL，并由系统浏览器打开 Sync Web。

### 测试与验收

- Manage Connections 只列出本机和远程 Core，没有独立 Sync URL 表单；
- Desktop state 和 IPC 不再持有 Sync profile，也不再读写 `desktop-sync.json`；
- Core Web 中的跨 origin Sync 管理链接交给系统浏览器；
- Windows 与 macOS 做 Core 切换、Sync 外链和多 Core 实机验收。

### 完成条件

Desktop 只表达多个 Core；Sync 连接属于各 Core，完整管理界面由 Core 面板导向系统浏览器。

## 阶段 11：CLI、开发生命周期与备份恢复

### CLI 与启动

在 `scripts/cinba.ts` 增加：

```text
cinba sync serve
cinba sync status
cinba sync reset-password
cinba sync backup
cinba sync restore
```

命令只管理本机 Sync Server，不经远程管理 API 伪装主机权限。`scripts/launch.ts` 提供仓库开发入口和
独立 state directory，但 Sync 不进入 Core 的 on-demand/idle reclaim 生命周期，也不随普通 Core
窗口关闭而停止。

### 备份恢复

- backup 包含 server identity、state、credential-key、Core token hash 和管理员验证信息；
- 导出时要求一次性迁移密码，用独立 salt/KDF/AEAD 再封装整个 archive；
- 临时明文文件禁止出现，输出文件默认私有权限；
- restore 先完整验证版本、密码、完整性和目标目录状态，再一次性提交；
- 备份或恢复期间 Server 进入只读维护状态；
- restore 默认拒绝覆盖非空目标，明确 `--force` 也必须先保留可恢复副本；
- URL 改变由各 Core 修改 connection URL，不要求重新 enrollment；旧 Server 不做自动重定向。

### 测试

- CLI 参数、退出码、无 TTY 服务运行和信号优雅关闭；
- status 不输出 Setup Code 以外的 secret，已初始化后不再显示旧 code；
- backup 中搜索不到已知明文 key、密码或 token；
- 正确/错误迁移密码、篡改、截断、未知版本和非空目标；
- restore 后 server identity、管理员密码、revision、Credential 与 Core credential 全部保持；
- 维护窗口拒绝 mutation，Core 仍使用本地缓存；
- 开发 Sync 与 Stable Sync state directory 隔离。

### 完成条件

一台没有 GUI 的主机可以安装前先用 CLI 完成启动诊断、密码重置和灾难恢复，日常管理仍在 Sync
Web 中完成。

## 阶段 12：部署、发布接线与真实端到端验收

### 改动

扩展 `packages/deploy` 与 release 流程：

- Linux 独立 `cinba-sync.service`，固定非 root 用户、私有 state directory、自动重启和健康检查；
- Caddy 示例只把 Tailscale/LAN HTTPS origin 反代到 loopback Sync port；
- 防止 Sync 端口意外监听公网地址，部署诊断检查 proxy header 与 HTTPS origin；
- release 同时包含 Sync Server、Sync Web 静态资源和 CLI，但不把它合并进 Core service；
- macOS launchd 作为同一独立服务模型接线；
- 文档记录 VPS、家用 Mac 和无 VPS 场景的等价部署步骤。

### 自动 E2E

新增真实进程测试，使用隔离临时目录和本地 TLS fixture，覆盖：

1. 启动 Sync Server，完成 Setup；
2. 注册普通 Core 与 Dev Core并批准；
3. 写入 Shared Settings、model key 和 Web Search key；
4. 普通 Core 得到 Settings + Credentials，Dev 只得到 Settings；
5. 更新 Settings 后两个 Core 同步，Override Core 保持本机有效值；
6. Sync Server 停止后两个 Core 从缓存启动；
7. 撤销普通 Core 后无法取得新 Snapshot；
8. backup → 新目录 restore 后原 Core credential 继续有效；
9. 管理和 Core 日志中扫描不到 seed secrets。

### 实机验收

- VPS：Caddy + Tailscale HTTPS、systemd 重启、backup/restore；
- Windows：Desktop 管理普通 Core，浏览器管理 Sync，验证离线缓存；
- Mac：Desktop 管理普通 Core，浏览器管理 Sync，可选本机托管 Sync Server；
- Dev：跟随 Shared Settings，同时无法读取或缓存 Shared Credentials；
- Mobile browser：Setup/Login、修改设置、替换 key、批准 Core；
- 会话中切模型后 Shared Settings 与其他 Core 均不改变；
- Shared key 轮换后新会话生效，旧会话不被强杀；
- `npm run check` 完整通过。

### 完成条件

发布产物可以在没有普通 Core 的 VPS 上独立运行 Sync Server；同一份产物也能在家用 Mac 上托管，
所有客户端的行为与设计中的位置无关原则一致。

## 推荐提交边界

每个边界都应在相关测试通过后提交，scope 使用实际 workspace 名称：

1. `docs(sync): record implementation probes`
2. `refactor(server): separate local settings and effective configuration`
3. `feat(sync-contract): define sync protocol`
4. `feat(sync-client): add typed sync http clients`
5. `feat(sync-server): add atomic store and credential encryption`
6. `feat(sync-server): add administrator authentication`
7. `feat(sync-server): add enrollment and snapshot APIs`
8. `feat(sync-web): add sync management interface`
9. `feat(server): add sync coordinator and offline cache`
10. `feat(agent): inject resolved provider credentials`
11. `refactor(extensions): consume resolved web tools configuration`
12. `feat(contract): add current core sync controls`
13. `feat(web): add current core sync settings`
14. `feat(tui): add current core sync flow`
15. `feat(desktop): add global sync service navigation`
16. `feat(sync-server): add backup and restore commands`
17. `feat(deploy): install independent sync service`
18. `test(sync): cover multi-core end-to-end workflow`

相邻的小提交可以在不模糊职责的前提下合并，但不得把 Credential 注入、协议变更、Desktop 安全边界
和部署脚本压进同一个不可审查提交。

## 主要风险与停止条件

### 1. Pi Provider 认证并非统一环境变量

若阶段 0 发现某些目标 Provider 只能通过 `auth.json` 或命令行明文传入，停止阶段 8，重新讨论
Credential 消费边界；不能为了“支持更多 Provider”把 key 写进参数或同步 OAuth token。

### 2. Electron 嵌入破坏 origin/cookie 隔离

Desktop 第一版使用系统浏览器打开 Sync Web，不再维护独立 Sync view、session partition 或手工
Sync URL。功能可降级，安全边界不可降级。

### 3. 新 runtime dependency

若严格 schema、加密 archive 或 UI 实现确实需要新增 runtime dependency，先说明替代方案、维护成本
和供应链影响，并按仓库规则征得用户同意。

### 4. Secret 出现在不可控日志

任何测试发现 API key、Core token、Setup Code、管理员密码或 session id 进入普通日志、错误、history、
URL、命令行或 UI 回显，立即停止功能扩展，先修复泄漏并增加回归测试。

### 5. 同时存在两个可写权威源

恢复或迁移流程若不能保证旧 Server 只读，第一版不提供在线迁移按钮。宁可停机备份恢复，也不允许
两个 Sync Server 分别接受 Shared Settings 更新。

## 最终验收矩阵

| 场景                | Settings        | Credentials       | 预期                                        |
| ------------------- | --------------- | ----------------- | ------------------------------------------- |
| 未连接的普通 Core   | Local           | Local             | 与现有行为一致                              |
| 已连接的普通 Core   | Sync            | Sync              | 跟随共享设置并取得 Shared API keys          |
| 已连接的 Dev Core   | Sync            | Local             | 跟随共享设置，生产 key 不下载、不缓存       |
| 带 Override 的 Core | Sync + Override | Sync/Local        | 只覆盖明确字段，Reset 后恢复跟随            |
| Sync 暂时离线       | cached Sync     | cached Sync/Local | 使用 last-known-good，状态显示 stale        |
| Core 被 revoke      | cached Sync     | cached Sync/Local | 旧缓存无法远程抹除，但不能取得后续 revision |
| 本地 OAuth 模型     | Sync default    | local OAuth       | 已登录可用，未登录提示本机登录，不误报 Sync |
| 会话临时切模型      | unchanged       | unchanged         | 只影响当前会话，不写 Shared/Override        |

最终发布前必须逐项保存验收证据，并运行一次完整 `npm run check`。真实 Secret 只能用于人工验收，
不得写进 fixture、截图、文档或命令历史。
