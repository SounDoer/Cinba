# Cinba Sync 产品体验设计

日期：2026-09-17

状态：产品决定已确认，尚未实施

相关现状：`docs/specs/2026-09-16-cinba-sync-design.md` 记录已经实施的第一版。本设计描述下一阶段
产品体验；发生冲突时，本设计是目标方向，但在对应迁移完成前，代码仍以已实施规格为准。

## 1. 背景

第一版已经验证了 Cinba Sync 的核心架构、协议、Web 管理界面、Core enrollment、共享设置、共享
凭据、VPS 服务和备份恢复能够完整工作。实机部署也暴露了下一阶段的主要问题：当前流程仍是一套
“可以由开发者部署和使用的工程”，还不是普通用户无需理解底层结构即可完成的产品流程。

本设计先收敛以下体验：

- Cinba 默认不要求 Sync，用户可以直接只在当前设备使用；
- 用户可以连接已有 Sync、在 GUI 设备创建本机 Sync，或部署始终在线的 Sync；
- 本机 Sync 不要求用户执行命令、记住端口或维护前台终端；
- 管理后台不要求用户创建并记住一个管理员密码；
- Sync Host、管理端和 Connected Core 使用彼此独立、容易解释的身份与权限；
- 尚未完整验证的远程网络方案不提前伪装成产品选项。

正式发布的产品不向用户展示 Stable、Dev 等开发环境概念。开发环境仍可在实现层隔离端口、目录和
身份，但不属于本设计的用户心智模型。

## 2. 产品入口

Cinba 首次启动不使用 Sync 选择阻塞用户。默认状态是：

```text
只在这台设备使用
```

用户进入 `Settings → Cinba Sync` 后看到当前状态和三个后续动作：

```text
Cinba Sync

当前状态
仅在这台设备使用
你的设置和凭据保存在本机。

[连接到已有的 Cinba Sync]
[在这台设备创建 Cinba Sync]
[部署一台始终在线的 Cinba Sync]
```

“只在这台设备使用”是默认状态，不是首次启动时必须点击的安装选项。

三个动作分别表示：

- **连接已有 Sync**：当前 Core 成为某个既有 Sync 的消费者；
- **在这台设备创建 Sync**：当前 GUI 设备成为 Sync Host；
- **部署始终在线的 Sync**：在 VPS、NAS 或其他常驻设备安装 Sync Host。

第三条路径的完整 VPS/TUI 部署体验需要单独设计，不在本文展开。

## 3. 权限模型

### 3.1 三种彼此独立的角色

```text
一个 Sync Host
├── 0…N 个受信管理端
└── 0…N 个 Connected Core
```

**Sync Host** 是安装并运行 Sync、保存权威数据和持有最终本机恢复能力的设备。一个 Sync 在任一时刻
只有一个权威 Host。

**受信管理端** 是获准访问 `sync-web` 管理能力的浏览器或 Desktop WebView。一个 Sync 可以有多个
受信管理端；它们只是管理入口，不保存权威 Sync 副本，也不会成为 Host。

**Connected Core** 使用独立的 Core credential 读取获准的 Sync Snapshot。一个 Sync 可以连接多个
Core。

管理授权和 Core 授权没有一一对应关系。同一设备可以同时运行受信管理端和 Connected Core，但两份
凭据、权限和撤销操作完全独立：

- 批准 Core 不会授予管理权限；
- 授予浏览器管理权限不会创建 Core；
- 撤销管理端不影响同机 Core；
- 撤销 Core 不影响同机浏览器。

### 3.2 Sync Host 是最终信任根

Sync 安装在哪里，哪里就是最终控制权所在。管理端是远程或本机的控制入口，不发生“Host 所有权转移”。

如果所有受信管理端都不可用：

- GUI Host 可以由本机 Cinba 重新签发一次性管理授权；
- VPS Host 可以通过主机本地 CLI 生成一次性管理授权。

这个恢复只重新建立管理入口，不改变 Host，不把普通 Core 提升为管理端。

## 4. 无密码管理授权

### 4.1 一次性配对

管理后台不要求用户名和日常密码。浏览器或 Desktop WebView 通过一次性配对成为受信管理端：

```text
Host 或已有受信管理端生成一次性授权
                    ↓
新管理环境完成一次配对
                    ↓
Host 签发独立的长期管理凭据
```

一次性配对材料必须：

- 高熵、短期有效且只能使用一次；
- 不进入访问日志、代理日志或 Referer；
- 使用 URL 时优先通过 fragment 交给页面处理；
- 成功交换后立即失效。

本机 GUI 创建流程由 Desktop 自动完成第一次配对，不向用户显示 Setup Code。VPS/TUI 初次部署可在
终端显示一次性链接或二维码，由用户选择的浏览器完成配对。

### 4.2 长期信任与撤销

配对成功后，管理端日常打开同一 Sync 地址即可进入管理后台，不必重复配对。每个管理端获得不同的
高强度随机凭据；Host 只保存可验证形式，不保存可复用明文。

管理后台提供独立列表与撤销操作：

```text
Trusted management access

Chrome on Windows     This browser · Active now
Safari on iPhone      Last used yesterday
Edge on Laptop        Last used 12 days ago
```

撤销只影响对应管理端。清除浏览器站点数据会使该浏览器失去管理权限，可以从其他受信管理端或 Host
本地重新配对。

具体凭据载体、持久 Cookie、CSRF、轮换和 Desktop 安全存储属于实施设计；无论采用何种载体，都不能
复用普通 Core credential。

## 5. Core enrollment

### 5.1 连接请求

新 Core 连接已有 Sync 时输入 Sync 地址和可识别的设备名称，然后主动发起 enrollment：

```text
新 Core 发起 enrollment
        ↓
管理后台出现 Pending request
        ↓
用户核对 Verification Code
        ↓
Approve / Reject
```

Verification Code 不要求手工输入，而是要求用户比较 Core 和管理后台显示的短码，并通过明确文案
确认两边一致：

```text
Confirm this code is shown on “Office Windows”:

482 731

[Code matches — Approve]
[Reject]
```

这避免用户在同名请求、并发请求或恶意垃圾请求中批准错误对象。

Pending request 在获批前没有读取 Settings、Credentials 或调用管理 API 的权限。服务端通过限流、
自动过期和待处理数量上限处理垃圾请求。

### 5.2 不增加 enrollment 开关

不要求管理员先“临时开启 enrollment”。只要 Sync 的部署本来就可被新 Core 访问，Core 可以随时提交
无权限的 Pending request；唯一真正的授权动作是管理端的 Approve。

管理后台可以展示 Sync 地址、复制按钮和二维码，但它们只是连接说明，不负责改变网络或 enrollment
开关。

### 5.3 本机创建的特殊路径

用户明确选择“在这台设备创建 Sync”时，当前 Core 可以在同一编排流程中自动 enrollment 和批准，
不要求用户创建后再批准同一设备。这个本机便利路径不能扩展成“同机所有 Core 自动获批”。

## 6. Settings 与 Credentials 来源

Settings 和 Credentials 分别选择来源。连接已有 Sync 时默认：

```text
Settings       Use shared settings
Credentials    Use credentials available only to this Core
```

连接页面允许用户分别请求 Shared Settings 和 Shared Credentials；批准页面必须准确显示请求范围。
Shared Credentials 默认关闭，并在请求时明确说明该 Core 将能使用 Sync 中保存的 API key。

第一版不做本地与共享数据的自动合并：

- 选择 Sync 来源后，共享值成为当前有效值；
- 原本的本地值继续保存，但暂时不生效；
- 断开 Sync 或切回 Local 后，本地值重新生效；
- 连接已有 Sync 不自动上传本地 Settings；
- 连接已有 Sync 不自动上传本地 Credentials；
- 删除本地副本必须是独立、明确的操作。

创建新的本机 Sync 时使用安全、可逆的默认值，不先增加初始化表单：

```text
Create Cinba Sync on this device

Your current settings will be used to initialize Sync.

API credentials will not be added to Sync or shared
with other Cores.

[Create Sync]
```

当前 Core 的 Settings 被复制为初始 Shared Settings；原 Local Settings 仍保留。API Credentials 不
自动写入 Sync，当前 Core 继续使用自己已有的 Local Credentials。这里不能使用“Credentials remain
on this device”一类文案，因为 Sync Host 也在同一物理设备上；产品文案必须表达凭据属于当前 Core，
还是已经加入 Sync 并可供获批 Core 使用。

### 6.1 主动断开

使用 Sync 一段时间后，Shared Settings 可能已经不同于连接前保存的 Local Settings。Core 主动断开
时不能静默恢复旧值，而要明确选择：

```text
Disconnect from Cinba Sync

What should this Core use after disconnecting?

● Keep the settings currently in use
  Copy the current shared settings to this Core.

○ Restore the previous local settings
  Return to the settings saved before connecting.
```

默认保留当前正在使用的 Settings，使断开只停止之后的同步，不让模型与偏好意外倒退。

如果 Core 正在使用 Shared Credentials，Credentials 使用单独的明确选择，不能随 Settings 自动复制：

```text
○ Do not save them to this Core
  Providers may require credentials after disconnecting.

○ Save them as credentials for this Core
  They will no longer receive updates from Sync.
```

这里不预选“保存”。保存后，原本由 Sync 管理和撤销的 API key 会成为该 Core 的持久本地副本，因此
必须由用户明确决定。OAuth 登录本来就不属于 Shared Credentials，不受这个选择影响。

### 6.2 管理端撤销 Core

管理端执行 `Revoke Core` 不是 Core 主动迁移，管理界面不会为被撤销 Core 提供把 Shared
Credentials 保存为本地副本的流程。撤销后：

- 后续 Snapshot 请求立即被拒绝；
- 正常 Core 在下次联系 Sync 并发现撤销后，清理 Sync credential 和从 Sync 获得的 Credentials 缓存；
- 最后一次 Shared Settings 可以成为断开后的本地设置，避免普通偏好突然消失；
- 依赖 Shared Credentials 的 Provider 进入需要本地凭据的状态。

撤销不能从一台离线、失陷或恶意的 Core 中远程抹掉已经交付的 API key。需要真正收回第三方 Provider
访问权时，用户还必须在 Provider 侧轮换对应 API key，并把新值更新到 Sync。主动断开是用户控制的
迁移行为；管理端撤销是阻止后续 Sync 访问的权限收回。

## 7. 本机 GUI Sync

### 7.1 创建流程

```text
Settings → Cinba Sync
        ↓
在这台设备创建 Cinba Sync
        ↓
创建并按需启动 Sync
        ↓
用当前 Settings 初始化；不加入 API Credentials
        ↓
当前 Core 自动连接并批准
        ↓
在 Desktop 中打开 sync-web
```

正常流程不显示端口、状态目录、环境变量、Setup Code 或终端命令。

### 7.2 按需生命周期

本机 Sync 默认不登录自启动，也不安装系统后台服务。第一阶段由现有 Desktop tray 进程托管：

- 用户没有创建本机 Sync 时，不启动任何 Sync 进程；
- 打开本机 Core 或管理后台时，Desktop 自动确保已配置的本机 Sync 运行；
- 关闭窗口后 Desktop 仍在系统托盘，Sync 继续稳定运行；
- 用户明确执行 `Quit Cinba` 时，Desktop 安全停止自己管理的本机 Sync；
- 下次启动并需要 Sync 时自动恢复；
- 不显示前台终端窗口。

未来可以提供“Cinba 关闭后仍供其他设备使用”的用户级后台模式，但必须由用户主动启用。后台模式不
等同于始终在线：GUI 设备休眠、注销或关机时仍然不可用。

### 7.3 复用现有 sync-web

`packages/sync-web` 仍是唯一完整管理界面，不新增 Desktop 专用管理实现：

```text
Cinba Desktop
└── Sync Management View
    └── sync-web

普通浏览器 / 手机浏览器
└── 同一个 sync-web
```

Desktop 默认在受限制的独立 WebView 中打开，并保留“在浏览器中打开”。WebView 必须使用独立、持久
的浏览器存储，禁用 Node 能力，限制到当前 Sync origin，并把外部链接交给系统浏览器。

Desktop 只负责编排本机生命周期、加载正确地址和建立本机首次管理授权。Shared Settings、
Credentials、Connected Cores、受信管理端、History 和 Backup 等管理能力仍然只在 `sync-web` 与
Sync Server 实现一次。

### 7.4 Disable 与 Delete

本机 Host 必须把可恢复的停用与永久删除分开，不能合并成含糊的 `Remove`：

**Disable Cinba Sync** 停止本机 Sync，取消之后的按需启动，但保留 Shared Settings、Credentials、
历史、Connected Core、管理授权以及各 Core 的连接配置。Core 暂时离线并使用自己的 last-known-good
缓存；用户以后 Enable 后可以原样恢复连接。

**Delete Cinba Sync permanently** 先让当前 Core 按第 6.1 节完成断开，再删除 Sync 权威数据和加密
key，使所有管理授权与 Core credential 永久失效。界面必须列出将删除的内容、显示仍连接的 Core
数量，并进行独立的危险操作确认。

备份仍是可选能力。删除确认可以提供 `Create backup first`，但不强制创建；用户明确确认永久删除且
没有备份时，产品可以执行不可恢复删除。

## 8. 网络边界

### 8.1 第一阶段仅承诺本机访问

本机 GUI Sync 的第一阶段只监听 loopback：

```text
Availability    This device only
```

不提供把监听地址改为 `0.0.0.0` 的开关，不自动修改防火墙，也不提供尚未完整验证的 Tailscale、LAN
HTTPS 或公网 HTTPS 向导。

当部署没有外部可达地址时，界面不显示误导性的“连接另一台设备”动作。当前本机 Core 已在创建流程中
自动连接。

### 8.2 网络部署与 Core 授权分离

远程网络入口属于部署能力；Core enrollment 属于应用授权。二者不能由一个“Connect another
device”按钮混合处理。

未来若提供“允许其他设备访问”开关，进入 On 状态必须代表 Cinba 已经建立并验证了安全、稳定的
HTTPS 入口，而不是简单暴露 HTTP 端口。支持某种方案前必须完整验证安装、TLS、地址稳定性、权限、
防火墙、重启恢复、URL 迁移与卸载撤销。

本设计暂不承诺本机 Sync 的远程访问。现阶段跨设备使用由已经具备安全网络入口的 VPS Sync 承担。

## 9. 备份与恢复

备份和灾难恢复是可选高级功能，不阻塞创建或部署 Sync。未配置备份时 Sync 可以完整使用，但用户接受
Host 永久丢失后无法完整恢复权威数据的风险。

需要区分两类恢复：

- **Host 仍在**：由 Host 本地重新签发一次性管理授权，不需要外部恢复密钥；
- **Host 永久丢失**：只有外部加密备份和独立保存的恢复密钥才能在新 Host 完整恢复。

管理后台可以低干扰地显示 `Disaster recovery: Not configured`，并在用户主动进入 Backup & Recovery、
准备迁移或卸载、首次保存重要 Shared Credential 等时提供说明，不使用阻塞弹窗强迫配置。

多个受信管理端不能替代备份。它们是控制入口，不持有权威 Sync 副本，也不能在 Host 丢失后自行选举
出新的 Host。

## 10. 第一实施切片

第一实施切片只交付本机 GUI Sync 的完整纵向路径：

- `Settings → Cinba Sync` 入口与默认本机状态；
- 创建本机 Sync；
- loopback-only；
- 由 Desktop tray 托管的按需生命周期；
- 本机第一次管理授权；
- 当前 Core 自动 enrollment 与批准；
- 用当前 Settings 一键初始化 Shared Settings；
- API Credentials 默认不加入 Sync；
- 在 Desktop 中复用现有 `sync-web`；
- 来源切换不删除本地数据；
- 主动断开与管理端撤销使用不同的 Settings/Credentials 处理；
- 可恢复的 Disable 与独立确认的永久 Delete。

这个切片明确不包含：

- 本机 Sync 对其他设备开放；
- Tailscale、LAN、公网 HTTPS 或 SSH tunnel 配置；
- 登录自启动或持续后台模式；
- VPS/TUI 新部署向导；
- 强制备份或恢复密钥；
- Passkey；
- 自动更新。

后续实施顺序由独立设计决定，不在本文把尚未验证的部署方案写成既定产品能力。

## 11. 与已实施第一版的主要差异

| 主题 | 已实施第一版 | 本设计目标 |
| --- | --- | --- |
| 管理身份 | Setup Code 后设置管理员密码 | 一次性配对受信管理端，无日常密码 |
| 管理入口 | 系统浏览器 | 复用 sync-web，Desktop 内置为默认入口，浏览器仍支持 |
| 本机生命周期 | Windows 前台运行；服务部署为 persistent | GUI 本机默认按需运行，后台模式以后显式启用 |
| Desktop 角色 | 只从当前 Core 导向系统浏览器 | 增加 Sync 产品入口与本机生命周期编排 |
| 本机远程访问 | 未产品化 | 第一实施切片仍不提供，不用不完整向导占位 |
| 备份 | CLI 能力已实现 | 保留为可选高级功能，不阻塞创建 |

这些差异需要兼容迁移设计，尤其是现有管理员密码、浏览器 session、VPS 实例和备份格式。本文不把
迁移细节与产品体验混写；实施计划必须单独说明如何保持现有实例可管理、可升级和可回滚。
