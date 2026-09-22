# Cinba Sync 设计

日期：2026-09-16

状态：第一版已实施；自动化测试与完整 `npm run check` 已通过。部署章节记录历史
源码部署形状；当前产品方向以 `docs/specs/2026-09-17-cinba-sync-product-experience.md` 为准。
实机验收与退役说明见 `docs/notes/2026-09-16-cinba-sync-deployment.md`。

## 1. 背景

Cinba 当前把一个 Core 的普通设置、凭据和本机运行状态都保存在该 Core 自己的数据目录中。本机
Stable、同机 Dev、家中 Mac 和 VPS Core 因此都要分别配置模型 Provider、默认模型和 Web tools。
隔离本身是正确的：各 Core 的项目、会话和开发凭据不能互相覆盖；缺失的是位于 Core 之上的一层
单用户共享设置。

这个问题不能通过持续复制 `~/.cinba` 或 `~/.pi/agent` 解决：

- `config.json` 同时包含可共享偏好和 `cwd`、最后会话、Core 名称等本机状态；
- `auth.json` 由 Pi 拥有，还可能包含会自动刷新的 OAuth token；
- `sessions/` 是各 Core 的真实对话数据，不能成为同步副作用；
- Stable 与 Dev 的状态目录隔离是为了避免开发代码意外接触真实凭据，不能用符号链接重新合并。

因此增加一个可选、位置无关、单用户自托管的 **Cinba Sync**。它集中保存一份普通共享设置和一份
共享 API-key 凭据，Core 只同步自己需要的完整快照，并继续独立拥有本机状态、会话、OAuth 登录和
可选覆盖。

## 2. 产品原则

### 2.1 Sync 是可选能力

没有部署或连接 Cinba Sync 时，Core 必须继续完整支持本地设置和本地凭据。连接 Sync 不是启动
Core、打开旧会话或使用 Cinba 的前置条件。

### 2.2 Sync Server 与部署位置无关

`Sync Server` 是独立服务角色，不属于 VPS、Mac 或任何一个 Core。它可以部署在：

```text
VPS
Mac / Windows 常开电脑
NAS / 家庭服务器
未来的托管服务
```

Core 只知道 `syncServerUrl` 和自己的 Core credential，代码与协议不得出现 `VPS_URL`、
`connectToVpsProfile()` 一类位置假设。当前个人部署选择 VPS 是部署决定，不是产品边界。

### 2.3 一个共享设置，而不是 Profile 系统

第一版只有一份 `Shared Settings`，不提供多个 Profile、继承、分组或环境模板。

仓库中 Desktop 已经使用 `CoreProfile` 表示一个保存的 Core 连接地址；新的共享设置不能再叫
`Profile`，否则同一界面和代码会出现两个完全不同的 Profile 概念。

### 2.4 Core 始终拥有本机事实

`cwd`、Core 名称、最后会话、Pi sessions、OAuth 登录、Instance Override 和 Sync 缓存属于一个
Core instance。Sync Server 不把这些数据提升为全局状态。

### 2.5 共享设置不控制当前会话

会话模型选择器只修改当前会话。Shared Settings 的默认模型只影响之后创建的新会话；修改共享
默认值不能强制切换正在回答或已经打开的会话。

### 2.6 先解决意外泄漏，不声称抵御主机失陷

第一版防止 API key 进入普通配置、日志、诊断、错误和未授权响应，并使用 HTTPS、用户级文件权限
和静态加密。它不声称能在 Sync Server 主机 root/管理员权限已被攻破，或一个已授权普通 Core 被
完全控制后继续隐藏该 Core 本来就必须使用的 API key。

## 3. 术语

| 名称               | 含义                                                          |
| ------------------ | ------------------------------------------------------------- |
| Cinba Sync         | 整套共享设置与凭据同步能力                                    |
| Sync Server        | 承载 Cinba Sync 的独立常驻服务                                |
| Shared Settings    | 唯一一份跨 Core 共享的普通设置                                |
| Shared Credentials | Sync Server 集中保存的 Provider API key                       |
| Local Settings     | 未连接 Sync 时由一个 Core 自己拥有的普通设置                  |
| Local Credentials  | 一个 Core 自己保存的 API key 或 Pi 登录，主要用于 Local/Dev   |
| Core Instance      | 一个持续存在的 Core 身份；进程重启不产生新实例                |
| Instance Override  | 某个 Core 对 Shared Settings 的可选局部覆盖                   |
| Effective Settings | Shared Settings 与 Instance Override 合并后的实际设置         |
| Sync Snapshot      | 一个 Core 一次性取得的完整、已发布同步版本                    |
| Sync Revision      | Shared Settings 或 Shared Credential 变化后生成的完整快照版本 |
| Settings Revision  | Shared Settings 每次保存或回滚生成的历史版本                  |
| Management Client  | 登录 Sync Server 管理页面的浏览器                         |

Desktop 的 `CoreProfile` 只表示“这台 Desktop 保存了哪些 Core 地址”；Sync Server 的 Connected
Cores 表示“哪些 Core 已注册到这台 Sync Server”。两者不能合并或互相替代。

## 4. 总体结构

```text
Mac / Windows / Mobile Browser
              │ administrator session
              ▼
        Cinba Sync Server
        ├── Management Web GUI
        ├── Shared Settings
        ├── Shared Credentials
        ├── Revisions
        ├── Connected Cores
        └── Backup / Restore
              ▲
              │ HTTPS JSON API + per-Core credential
      ┌───────┼─────────┐
      │       │         │
 Windows   Mac Core   VPS Core
 Stable

Windows Dev
├── Shared Settings from Sync
└── Local Credentials only
```

Sync Server 和 Core 是平级进程。它们可以同机部署，但使用独立生命周期、监听端口和状态目录：

```text
~/.cinba/       一个普通 Core 的状态
~/.cinba/dev/   同机 Dev Core 的状态
~/.cinba-sync/  Sync Server 的权威状态
```

Sync Server 不启动 Pi、不读 sessions、不管理项目目录，也不依赖普通 Core Server 才能运行。

## 5. 设置来源与合并

### 5.1 支持的组合

设置和凭据分别选择来源：

| Settings source | Credential source | 用途                               |
| --------------- | ----------------- | ---------------------------------- |
| Local           | Local             | 单机、完全离线、未连接 Sync        |
| Sync            | Sync              | 普通多设备 Core                    |
| Sync            | Local             | Dev Core 或明确选择本地凭据的 Core |

第一版不支持 `Local Settings + Shared Credentials`。它没有当前实际用途，还会增加来源冲突。

### 5.2 Shared Settings

第一版只有两个用户字段：

```ts
type SharedSettings = {
  defaultModel?: {
    provider: string;
    id: string;
  };
  webTools: {
    searchPrimary: "auto" | "exa" | "brave";
  };
};
```

不增加 fallback 模型、工具开关、thinking level 或权限策略；真实需要出现后再扩展同一版本化结构。

### 5.3 Instance Override

Override 与 Shared Settings 同形，但字段全部可选：

```ts
type InstanceOverride = {
  defaultModel?: ModelRef;
  webTools?: {
    searchPrimary?: "auto" | "exa" | "brave";
  };
};
```

合并规则是字段级“本机值存在则覆盖”，没有 Override 时自然跟随后续共享更新：

```text
Shared Settings + Instance Override = Effective Settings
```

界面必须表达来源，而不是把共享值复制成本地值：

```text
Default model
● Use shared setting: deepseek-v4-pro
○ Override for this Core

[Reset to shared]
```

### 5.4 会话模型

三个入口严格分开：

```text
Sync 管理页面
└── 修改 Shared Settings.defaultModel

Core 设置
└── 修改 Instance Override.defaultModel

会话模型选择器
└── 只修改当前会话
```

新会话的起始模型按以下顺序解析：

```text
创建会话时显式指定
→ Instance Override.defaultModel
→ Shared Settings.defaultModel
→ Pi 默认模型
```

## 6. Credentials

### 6.1 第一版模型

一个 Provider 全局只有一份 Shared Credential：

```text
deepseek → one API key
openai   → one API key
exa      → one API key
brave    → one API key
```

不增加命名 Credential、多账号或 Provider 内选择。更新一项 key 后，所有使用 Shared Credentials
的 Core 在下一次同步时取得新值。

### 6.2 只同步 API key

Sync 第一版同步普通 API-key Provider，以及 Exa/Brave Web Search key。以下凭据继续属于各 Core
本地 Pi `auth.json`：

- ChatGPT Plus/Pro、Claude Pro/Max、GitHub Copilot 等 OAuth/订阅登录；
- 会自动刷新或与设备登录流程绑定的 token；
- Dev Core 的本地 API key。

Shared Settings 可以选择一个需要本地 OAuth 登录的模型；没有在本 Core 登录时，界面必须显示
“Shared default requires a local provider login”，不能把它误报成 Sync 失败。

### 6.3 Dev 规则

Stable/Dev 是本地 Core instance 和启动目录的区别，不是 Sync 内建 Profile。Dev 默认：

```text
Settings source: Sync
Credential source: Local
```

它同步普通 Shared Settings，但不请求、不下载也不缓存 Shared Credentials。Dev 本地凭据继续存于
`~/.cinba/dev` 与 `~/.cinba/dev/pi-agent` 所代表的隔离边界。

这条规则防止开发代码意外继承生产 API key，不构成同一操作系统用户下的恶意代码沙箱。

### 6.4 写入与读取边界

管理 API 对 Credential 只允许覆盖和删除：

```json
{ "provider": "deepseek", "configured": true }
```

它永不把旧值读回 GUI。只有已批准、Credential source 为 Sync 的 Core 能通过 Core Sync API 取得
明文 key。响应必须使用 HTTPS、`Cache-Control: no-store`，并禁止进入访问日志和错误正文。

### 6.5 Core 本地缓存与消费者

普通 Core 下载 Shared Credentials 后，以当前系统用户私有、原子替换的本地缓存保存。这样 Sync
暂时离线或 Core 重启时仍能工作。撤销 Core 可以阻止未来下载，但不能远程抹掉一台已经离线或被
控制机器上的旧缓存。

Core 是唯一的 Credential 来源解析者：

- 模型 API key 由 Core 在启动 Pi 子进程时通过对应 Provider 环境变量注入；
- Web tools 读取 Core 已经合成的有效运行配置；
- `packages/extensions` 不再自行决定 Local/Shared/环境变量的优先级；
- Pi `auth.json` 的 OAuth entry 保留；同步模式下冲突的本地 API-key entry 必须被报告而非静默
  覆盖 Shared Credential。

Shared key 更新后，新 Pi 会话使用新值；第一版不为 key 轮换强制中断已经运行的 Pi 会话。

## 7. Core Instance 注册

每个 Core instance 获得独立 credential，不共用一个全局 Core token。首次连接流程：

1. Core 输入或收到 Sync Server URL；
2. Core 提交名称、平台和 Credential source；
3. Sync Server 创建 pending enrollment；
4. 管理页面显示请求，用户选择 Approve 或 Reject；
5. Approve 后签发一次性返回的 Core credential；
6. Core 保存 credential，之后自动认证；
7. Sync Server 只保存 token hash，不保存可再次读出的原始 token。

等待批准页面可以短时间轮询 enrollment 状态；批准后立即停止。管理页面允许单独 Revoke 一个
Core，其他 Core 不受影响。

Core credential 只能：

- 查询自己的最新 revision；
- 下载自己模式允许的 Sync Snapshot；
- 上报自己的非秘密能力与同步状态。
- 撤销自身授权，用于完成主动断开。

它不能修改 Shared Settings、写 Credential、批准 Core、读取其他 Core token 或调用管理 API。

## 8. 模型与 Provider 能力发现

Sync Server 本身不运行 Pi，因此不能直接调用 Pi 的模型选择器或认证运行时。已批准 Core 定期或在
模型/凭据变化后上报不含 secret 的能力摘要：

```ts
type CoreCapabilities = {
  providers: Array<{
    id: string;
    name: string;
    authKind: "api-key" | "oauth" | "other";
  }>;
  models: ModelRef[];
};
```

Sync Server 缓存各 Core 最近一次报告，Sync Web 使用这些数据构建默认模型选择器，并显示所选模型
在哪些 Core 上可用。它不把某一台 Core 的列表宣称为全局绝对事实。

没有任何 Core 上报时，Shared Settings 可以暂时没有默认模型；第一版不要求用户手填未知的
provider/model 字符串，也不因此让 Sync Server 依赖 Pi。

## 9. 同步协议

### 9.1 HTTPS JSON，而非 WebSocket

Sync 使用低频请求/响应式 HTTPS JSON API。Core 的 WebSocket 继续服务流式模型输出、工具调用和
实时会话，不复用到 Sync。

同一 Sync Server 提供两组逻辑 API：

```text
Management API
└── administrator session

Core Sync API
└── per-Core credential
```

实际路由可以在实施计划确定，但权限解析和 handler 必须分开，不能只靠客户端约定。

### 9.2 Snapshot 与 revision

Core 一次取得完整版本：

```ts
type SyncSnapshot = {
  syncRevision: number;
  settings: SharedSettings;
  credentials?: Record<string, string>;
};
```

`syncRevision` 在 Shared Settings 或任一 Shared Credential 改变时递增。没有变化时只返回 Not
Modified；有变化才下载 Snapshot。Core 先校验、写临时缓存，再一次性替换旧缓存并记录
`syncRevision`。任何一步失败都继续使用上一份 last-known-good，不能留下半套新设置。

### 9.3 触发时机

正常同步包含：

- Core 启动时检查一次；
- 低频后台检查，具体间隔由实施计划与测试确定，量级为数分钟而非数秒；
- 用户显式点击 `Sync now`。

短时间的 enrollment 等待可以每几秒检查；它不是永久后台轮询。

### 9.4 离线行为

Sync Server 不可达时：

- 已连接 Core 使用最近成功的 Shared Settings 和 Shared Credentials 缓存；
- 不退回另一套 Local Settings，避免无声切换模型；
- 现有会话和本地功能继续工作；
- 状态显示最后成功 revision、最后检查时间和离线原因；
- 管理页面无法连接时不得把本地表单修改伪装成已经保存。

### 9.5 并发管理

即使只有一个用户，也可能同时打开 Mac 和手机页面。更新 Shared Settings 必须携带页面读取时的
base `settingsRevision`。Server 当前 Settings Revision 不同则拒绝静默覆盖，要求刷新后重试。

第一版不做字段级自动合并。回滚历史版本会创建一个新的 Settings Revision，同时发布新的 Sync
Revision；它不删除或改写旧历史。Credential 更新只递增 Sync Revision，不伪造一条 Shared
Settings 历史。

## 10. Sync Server 存储

### 10.1 第一版使用原子 JSON Store

单用户第一版只有一份设置、少量 Credential、Core 和 revision，不引入数据库。默认目录：

```text
~/.cinba-sync/
├── state.json
└── credential-key
```

`state.json` 保存：

- schema version；
- 当前 Shared Settings、Settings Revision 与历史；
- 当前 Sync Revision；
- 加密后的 Credential value 与元数据；
- Connected Core、pending enrollment 和 token hash；
- 管理员密码验证信息；
- Sync Server 稳定身份。

管理员浏览器 session 可以只存在内存中；Sync Server 重启后重新登录是可接受行为。

所有状态变更由一个 `SyncStore` 串行化，写入完整临时文件、刷新、校验后原子替换。文件不可读或
schema 不支持时必须拒绝写入并给出可操作错误，不能静默覆盖成空状态。

业务代码只通过 `SyncStore` 接口访问；以后若真实规模需要 SQLite，可以替换 store 而不改变 API。

### 10.2 Credential 静态加密

安装时自动生成 Credential 加密 key，用户不输入、不查看也不日常解锁。Server 重启后自动从本机
私有文件读取，因此常驻服务可以无人值守恢复。

第一版使用 Node 内置、带认证的加密原语，保存格式必须带显式版本、随机 nonce、authentication
tag 和 ciphertext。key 文件与 `state.json` 分离，只允许运行 Sync Server 的系统用户读取。

加密防止普通状态文件或备份副本单独泄漏 API key；它不抵御同时取得主机文件与运行权限的 root/
管理员攻击者。

## 11. 管理员身份

第一版是单用户，无用户名、邮箱、组织、成员或邀请系统。

首次部署：

1. Sync Server 生成一次性 Setup Code；
2. 用户从任意受信设备打开 Sync Web；
3. 输入 Setup Code 并设置管理员密码；
4. 初始化成功后 Setup Code 永久作废。

以后只输入管理员密码。密码只保存强密码哈希与随机 salt；管理 session 使用 `Secure`、`HttpOnly`、
严格 SameSite cookie，并防止 CSRF。忘记密码时必须在运行 Sync Server 的主机上执行本地重置命令，
生成新的临时 Setup Code；不做邮箱找回。

Tailscale/局域网访问控制与管理员认证是两层边界。协议不依赖 Tailscale 身份，以便相同服务部署在
普通局域网、NAS 或未来托管环境。

## 12. 客户端层级

### 12.1 Sync Web 是唯一完整管理界面

`packages/sync-web` 提供响应式页面：

```text
Setup / Login
Overview
Shared Settings
Credentials
Connected Cores
History
Backup / Restore
```

它由 Sync Server 提供，但在 Mac、Windows 或手机浏览器中渲染。Sync 部署在无桌面的 VPS 上不
意味着需要完整管理 TUI。

### 12.2 Core Web 与 TUI 只管当前 Core

现有 Core 客户端只提供：

- 当前 Core 的 Sync 状态与 revision；
- Connect / Disconnect；
- `Sync now`；
- Instance Override；
- Settings/Credential source；
- 打开或显示 Sync 管理 URL。

它们不保存管理员密码，也不代理修改 Shared Settings 或 Credential。

### 12.3 Desktop 只管理 Core 导航

Desktop 只管理多个 Core connection profile，不再单独保存 Sync Server URL，也不再提供与
Core 列表平级的 Sync 全局入口：

```text
Desktop
├── Cores
│   ├── Local Core
│   └── VPS Core
```

打开某个 Core 时加载现有 `packages/web`。用户从当前 Core 的 Sync 面板进入管理界面，
`Open Sync management` 把已连接 Core 记录的 management URL 交给系统浏览器。Desktop 不要求
用户重复录入同一 URL，也不保存 Sync 管理员 cookie、密码或 Core credential。

## 13. 网络与部署

本节是已退役的第一版源码部署设计，不是当前正式安装指南。`packages/deploy`、
`prod` 分支和定时拉取 checkout 的产品路径已退役；后续本机 GUI Sync 和始终在线部署
分别按新产品体验规格设计。

Sync Server 默认只监听 loopback，通过部署者提供的 HTTPS reverse proxy 暴露。当前 VPS 形状：

```text
Mac / Windows / Mobile
        │ Tailscale HTTPS
        ▼
      Caddy
        ▼
127.0.0.1:<sync-port>
   Sync Server
```

第一版个人部署只允许 Tailnet 内访问；不开放裸 HTTP 公网端口。实现使用通用的 Sync Server URL，
不把 Tailscale 写进业务协议。

Sync Server 是 persistent 服务，不使用 Core 的 on-demand/idle reclaim 生命周期。Linux 由独立
`cinba-sync.service` 托管；macOS 后续由独立 launchd job 托管。它与 Core 可以来自同一 release，
但独立启停、健康检查和保存状态。

VPS/主机侧 CLI 只负责安装、诊断和恢复：

```text
cinba sync serve
cinba sync status
cinba sync reset-password
cinba sync backup
cinba sync restore
```

不要求第一版提供完整远程管理 TUI。

## 14. 备份、恢复与迁移

备份必须包含恢复同一 Sync identity 所需的 Shared Settings、revision、加密 Credential、Credential
加密 key、Connected Core token hash 和管理员验证信息，并用一次性迁移密码再次封装。导出文件是
敏感资产，不能因已加密就进入公开仓库。

恢复到新主机后保留 Core instance 身份和管理员密码。若公开 URL 保持不变，各 Core 无需操作；若
URL 改变，第一版允许在每个 Core 修改 URL，但不要求重新 enrollment。

迁移期间旧 Sync Server 必须进入只读模式，不能让旧、新两个可写权威源产生分叉。Core 在窗口期
继续使用本地 last-known-good 缓存。

旧 Server 向 Core 签名宣布新地址属于后续优化；第一版不实现。没有备份或丢失 Credential key 时，
普通 Shared Settings 可以重建，但 Provider API key 必须重新输入。

## 15. 数据所有权

| 数据                       | 权威来源                            |             是否同步 |
| -------------------------- | ----------------------------------- | -------------------: |
| Shared Settings            | Sync Server                         |                   是 |
| Shared Credentials         | Sync Server                         | 是，仅普通 Sync Core |
| Settings Revision history  | Sync Server                         |                   是 |
| Sync Revision              | Sync Server                         |                   是 |
| Connected Core registry    | Sync Server                         |         否，管理数据 |
| Local Settings             | Core Local State                    |                   否 |
| `cwd`                      | Core Local State                    |                   否 |
| Core name                  | Core Local State；Sync 保存展示副本 |                   否 |
| last session               | Core Local State                    |                   否 |
| Instance Override          | Core Local State                    |                   否 |
| Pi sessions                | Pi agent directory                  |                   否 |
| OAuth/subscription login   | Pi `auth.json`                      |                   否 |
| Shared Settings cache      | Core cache                          |               可重建 |
| Shared Credentials cache   | Core cache                          |         可重建但敏感 |
| Sync URL / Core credential | Core Local State                    |                   否 |
| Desktop CoreProfile        | Desktop user data                   |                   否 |

## 16. 仓库与依赖边界

新增四个 package：

```text
packages/sync-contract/  HTTP 协议类型与严格解析
packages/sync-client/    Core 与管理端的统一 HTTP client
packages/sync-server/    权威状态、认证、API、静态 Web
packages/sync-web/       唯一完整管理 UI
```

依赖方向：

```text
sync-contract
   ↑        ↑
sync-client sync-server
   ↑
Core Server

sync-web
├── sync-client
└── sync-contract
```

禁止 `sync-server` 依赖普通 Core Server、`@cinba/agent`、Pi sessions 或项目运行时。

现有 package 的职责变化：

- `packages/server`：拆开 Local State，增加 connection/cache/coordinator/scheduler/effective settings；
- `packages/agent`：接受解析后的 Provider 环境并传给 Pi，不连接 Sync；
- `packages/extensions`：消费 Core 已解析的 Web tools 运行配置，不重新实现来源优先级；
- `packages/contract`：只增加当前 Core 的 Sync 状态与 Connect/Sync now/Disconnect 操作；
- `packages/core-client`：封装上述 Core 操作，不承载管理员 API；
- `packages/web` / `packages/tui`：当前 Core 的状态、来源和 Override；
- `packages/desktop`：保留 CoreProfile Store，Sync 管理由 Core Web 导向系统浏览器；
- `packages/installer` / `packages/product-runtime`：正式安装中的 Sync 运行入口、独立数据目录、
  服务注册和生命周期模式；
- `scripts/cinba.ts`：源码开发环境的 Sync 本机管理与恢复命令；
- `scripts/launch.ts`：仓库开发入口，不把 Sync 混进普通 Core 生命周期。

改变 `packages/contract` 后，必须确认 Web、TUI 和 Desktop 都跟上。

## 17. 第一版范围

### 17.1 包含

- 单用户、自托管、位置无关的 Sync Server；
- 一份 Shared Settings；
- default model 与 Web Search primary；
- 一个 Provider 一份 API key；
- API-key Credential 同步与 OAuth 本地化；
- Local/Sync Settings source；
- Local/Sync Credential source；
- Dev 默认 Shared Settings + Local Credentials；
- Instance Override；
- Core enrollment、Approve、Revoke；
- 启动检查、低频轮询、`Sync now`；
- 原子 Snapshot cache 与离线 last-known-good；
- 响应式 Sync Web；
- Desktop 全局入口和现有客户端状态入口；
- Sync Revision、Settings Revision conflict、history 与回滚；
- 完整备份、恢复和主机迁移；
- Tailscale + Caddy 的首个真实部署。

### 17.2 不包含

- 多个 Profile 或 Shared Settings 集合；
- Profile 继承；
- 多用户、组织、邀请、角色；
- 同一 Provider 多份 Credential；
- Provider 级 per-Core grant；
- OAuth token 同步；
- 外部 secret manager；
- WebSocket push；
- 多 Sync Server、leader election 或 HA；
- 离线修改共享设置；
- 字段级冲突合并；
- 旧配置、`auth.json` 或 API key 自动迁移；
- 旧 Server 自动重定向所有 Core；
- 完整管理 TUI；
- 原生移动 App；
- Cinba 托管云服务。

## 18. 实施顺序

1. 在纯 Local 模式下拆出 Local State、Instance Override、Effective Settings 和 Credential source，
   保持现有行为；
2. 实现 sync-contract、sync-client、sync-server 的 Store、认证、enrollment、revision、Credential 与
   Snapshot API；
3. 实现 sync-web 的 Setup/Login、Shared Settings、Credentials、Connected Cores、History 和
   Backup；
4. Core 接入连接、scheduler、cache、Effective Settings、Pi API key 和 Web tools；
5. 同步更新 contract、core-client、Web、TUI、Desktop；
6. 增加 systemd/launchd、Caddy/Tailscale 部署，完成真实 Windows、Mac、VPS 和 Dev 验收。

实施计划必须按可独立验证的阶段拆分，不能用一次巨型提交跨越全部协议、服务、客户端和部署。

## 19. 验收

- 未连接 Sync 的 Core 与当前 Local 模式行为一致；
- Windows、Mac、VPS 普通 Core 使用同一 Shared Settings 与 Shared Credentials；
- Dev 同步 Shared Settings，但无法请求 Shared Credentials；
- 会话切模型不修改 Shared Settings；
- Instance Override 不反向写入 Sync Server；
- 更新默认模型只影响新会话；
- 更新 Web Search primary 后下一次搜索使用新顺序；
- 更新模型 API key 后新 Pi 会话使用新值；
- Core 离线时使用 last-known-good，并明确显示离线状态；
- 过期 revision 的管理页面不能覆盖新设置；
- 未认证请求、被撤销 Core 和 Local Credential Core 都拿不到 Shared Credential；
- 管理 API、日志、错误、诊断、普通状态和备份元数据不暴露 API key；
- Desktop 的 CoreProfile 不保存 Sync URL，与 Sync Connected Cores 保持独立；
- Sync Server 可以在不运行 Core 的主机独立工作；
- 备份恢复后保留 Shared Settings、Credential、history 与 Core identity；
- Tailscale 内的 Mac/Windows/手机浏览器可以管理 VPS Sync Server；
- `npm run check` 完整通过。
