# Cinba 产品分发、安装、更新与卸载设计

日期：2026-09-17

最后更新：2026-09-21

状态：产品规格与代码纵向路径已完成，`v0.1.1` 已从 `a54322a` 正式发布；三平台原生构建、公开
bootstrap、真实 VPS 安装和首个跨版本发现已验收，仍等待 macOS 真实用户安装验收

相关下游设计：`docs/specs/2026-09-17-cinba-sync-product-experience.md`

## 1. 背景

Cinba 已经具备 Desktop、TUI、Core、Sync 和真实 VPS 运行能力，但这些能力目前仍从源码 checkout
启动：

- Desktop 通过仓库中的 Electron 开发依赖运行，没有 Windows/macOS 正式安装包；
- TUI 依赖 Node、完整源码仓库、`npm install` 和 `npm link`；
- 本机 Core 的入口、revision 和 ownership 仍绑定 Git checkout；
- 全新 Linux 主机需要人工准备用户、Node、checkout、systemd 和首个 release；
- `packages/deploy` 负责 bootstrap 完成后的 Git 驱动部署、验证和回滚，不是产品安装器；
- 根 package 仍为 private、版本为 `0.0.0`，没有统一可下载的正式 release artifact；
- Desktop 没有正式更新和卸载链，VPS 更新也仍是现场 `npm ci`、检查和构建源码。

已有实现中值得保留的是统一产品命令、Core 安全 draining、健康检查、候选隔离、原子切换和失败回滚
等机制，而不是当前 checkout、Node、目录和 `prod` 分支布局。

本设计建立上游的 Cinba 产品分发体系。Sync 的认证、enrollment、Settings/Credentials 来源和管理体验
继续由下游 Sync 规格负责；本文只定义它对安装、服务、更新和数据所有权的要求。

## 2. 统一术语

正式产品只使用以下名称：

| 含义                    | 统一称呼                                                    |
| ----------------------- | ----------------------------------------------------------- |
| 用户安装的正式产品      | **Cinba**                                                   |
| 从源码运行的开发产品    | **Cinba Dev**                                               |
| 正式产品的 Core         | **Cinba Core**；需要位置时使用 **Local Core / Remote Core** |
| 开发产品的 Core         | **Cinba Dev Core**                                          |
| GitHub 上的一次正式发布 | **release**                                                 |
| 下载后尚未启用的版本    | **candidate release**                                       |
| 当前运行版本            | **current release**                                         |
| 本地源码构建            | **development build**                                       |

新产品、代码和文档不再使用 `Stable`、`Stable Core` 或 `stable build`。历史规格保留当时用语，不做
追溯改写；本文之后的实现应逐步替换现有 `STABLE_*` 等命名。

第一阶段只有一个正式更新通道，因此不提前引入名为 `stable` 的 channel 字段。Cinba Dev 是独立应用
身份，不是 Cinba 内可切换的更新通道。

## 3. 两种顶层安装形态

正式产品只有两种顶层安装形态。

### 3.1 Cinba Desktop

适用于 Windows 和 macOS，包含：

- Desktop GUI 与 Tray/Menu Bar；
- `cinba` Shell CLI；
- TUI；
- Core；
- Sync Server 与 sync-web；
- 匹配版本的运行时与内置 Pi；
- 安装、更新、后台组件管理和卸载能力。

安装 Desktop 后，新终端默认可以直接运行 `cinba`，不需要再安装 Headless、Node、npm 或执行
`npm link`。具体 PATH/launcher 实现按平台设计，但必须由同一个安装拥有并在卸载时清理。

### 3.2 Cinba Headless

适用于 Linux，包含：

- `cinba` Shell CLI；
- TUI；
- Core；
- Sync Server 与 sync-web；
- 匹配版本的 Node 运行时与内置 Pi；
- 安装、更新、后台组件管理和卸载能力。

Headless 不是“TUI 单独安装包”。CLI、TUI、Core 和 Sync 是同一个安装中的组件。

### 3.3 统一命令入口

Desktop 与 Headless 安装同一个 `cinba` Shell 入口：

- `cinba` 不带子命令时进入 TUI；
- `cinba <subcommand>` 执行状态、更新、诊断、Background 管理和卸载等管理操作；
- Desktop 仍从 Windows 开始菜单或 macOS 应用启动，不改变 `cinba` 的默认 TUI 语义。

这里的 CLI 指命令及其子命令框架，TUI 指该命令启动的全屏交互客户端，不是两个独立安装的产品。

### 3.4 不单独安装内部组件

普通用户不分别安装 Web、TUI、Core 或 Sync。未来组件也应接入 Cinba 的版本、安装清单、服务管理和
更新基础，而不是各自携带 Node、创建 updater 或发明 bootstrap。

## 4. 平台与 artifact

第一阶段支持：

- Windows 10/11 x64；
- macOS 13.5 Ventura 或更高版本，Apple Silicon；
- x86_64 GNU/Linux，kernel 4.18 或更高、glibc 2.28 或更高；首要验收环境为 Ubuntu
  22.04/24.04。

暂不承诺 Windows ARM64、Intel Mac、Linux ARM64、Windows Server、Alpine/musl 或独立 Windows
Headless。WSL 按 Linux Headless 处理。Linux CLI、TUI 和 On-demand 不要求 systemd；Background 只有在
systemd user service 可用时才启用，否则提供明确诊断。

安装器在写入内容前验证平台和系统下限。未来 release 提高下限时，旧系统上的 updater 应明确显示
“存在新版但当前系统不兼容”，不下载或尝试安装，也不为旧系统维护单独发布线。

首个正式安装版从 `v0.1.0` 开始。它是正式 Cinba release，不称为 beta、preview、Dev 或 Stable。
安装、更新、卸载、后台服务和真实跨版本升级完成验证后，再决定进入 `v1.0.0`。

一次 `vX.Y.Z` release 来自同一个 Git revision，使用一个 SemVer 产品版本，并发布平台专用
artifact：

```text
Cinba vX.Y.Z
├── Windows Desktop installer
├── macOS Desktop installer/package
├── Linux x64 Headless artifact
└── release manifest 与校验值
```

统一的是产品版本、源 revision、协议、内部 payload 规范与发布批次，不是让所有平台下载同一个文件。
CI 按平台构建包含 CLI、TUI、Core、Sync、Node、Pi 和资源的标准 payload；Windows/macOS Desktop 包
将对应 payload 与 Desktop 一起封装，Linux artifact 封装同类 Headless payload。Desktop 安装时不再
下载第二份 Headless 包。Desktop、CLI、TUI、Core、Sync 和 manifest 不各自编号。

所有正式 artifact 必须自包含。安装阶段不运行 `npm install`，也不从 npm、Node 官网或 pi.dev 下载
运行依赖。用户可以手工下载 artifact 后复制到离线机器安装；只有检查或下载 Cinba 更新时才需要访问
GitHub Releases。

第一阶段不提供 Desktop portable 版本。Windows 使用用户级 `.exe` 安装器，macOS 使用 `.dmg`；底层
打包技术选型属于实施设计，但必须满足本文确认的 per-user、CLI 默认可用、版本化更新和卸载语义。

## 5. 正式发布源与信任边界

第一阶段唯一正式上游是当前公开仓库的 GitHub Releases。它承载：

- `vX.Y.Z` tag；
- 各平台 artifact；
- release manifest 和校验值；
- release notes。

不虚构尚不存在的下载域名、安装 URL 或命令。

正式 release 启用 GitHub Immutable Releases。发布前先以 draft 集齐并验证完整产物；正式发布后 tag、
release notes 和 assets 不再替换。Updater 只接受非 draft、非 prerelease、符合 manifest 的正式 release，
且 artifact 下载地址必须属于同一个 Cinba GitHub Release。

Cinba 当前是个人自用项目，正式 Windows/macOS artifact 可以未经过平台代码签名或 macOS
notarization。发布说明必须诚实解释可能出现的 SmartScreen/Gatekeeper 提示；代码签名是未来可选增强，
不阻塞第一版分发。

Manifest 至少记录产品版本、Git revision、协议版本、数据格式版本、支持平台与系统下限、artifact
文件名、大小和 SHA-256。Artifact 内另带安装清单，用于安装后核对文件完整性。CI 为产物生成 GitHub
artifact attestation，供发布审计使用；第一阶段不在 Cinba 内实现独立 Sigstore verifier。

校验值用于发现下载损坏或 artifact 与 manifest 不一致。由于 manifest 和 artifact 来自同一个未签名
的 GitHub release，它不宣称能抵御 GitHub 发布权限本身失陷。

## 6. 正式 release 流程

正式发布由不可变 tag 定义，不再由部署分支定义：

根 `package.json` 的 version 是唯一产品版本来源；private workspace 不独立发布、也不拥有各自的产品
版本。正式构建使用 GitHub Actions 的 Windows、macOS、Linux matrix，每个平台必须在对应原生 runner
上构建和验证，不能在一个平台交叉拼装其他平台 payload。

```text
master 完成并通过检查
        ↓
明确选择版本并锁定 master SHA
        ↓
Windows / macOS / Linux 从同一 SHA 构建并验证
        ↓
在该 SHA 创建 vX.Y.Z tag 与 draft Release
        ↓
上传同一批已验证 artifact、manifest、attestation 和 release notes
        ↓
完整性复核后正式发布并进入 immutable 状态
```

Windows、macOS、Linux artifact 和 manifest 必须全部构建验证成功后，才发布整个 release；不发布
缺失部分平台的正式版本。

Release notes 只服务于“把 Cinba 装上”，保持简短；卸载、Background 与 linger 等使用细节属于仓库
文档，不进入 release notes。每条 GitHub Release notes 必须包含版本变更说明，以及 Windows、macOS、
Linux 三个平台的中文安装说明和紧随其后的英文安装说明。说明需列出准确 artifact 文件名与系统下限、
Windows SmartScreen 提示、macOS Gatekeeper 被阻止时的系统设置放行路径与 `xattr` 命令、Linux 推荐
与离线安装方式、已有用户的产品内更新方式，以及必要的数据兼容变化。Release notes 模板不完整时
保持 draft，不能正式发布。

新体系完成并验收后，`prod` 分支可以删除。现有 `master → prod` promotion、VPS 定时 Git fetch 和
相关 release skill 随之退役。现在不删除 `prod`，也不改变现有线上环境。

## 7. Cinba 与 Cinba Dev

正式版和开发版是两个完整独立的应用身份：

| 维度                | Cinba                     | Cinba Dev         |
| ------------------- | ------------------------- | ----------------- |
| 来源                | GitHub Release 安装       | 本地源码 checkout |
| 用户数据            | 正式数据目录              | 独立 Dev 数据目录 |
| Credentials / 会话  | 不共享                    | 不共享            |
| Core profiles       | 不共享                    | 不共享            |
| 端口、PID、锁、日志 | 正式命名空间              | 独立 Dev 命名空间 |
| 后台组件            | 正式标识                  | 独立 Dev 标识     |
| 更新                | 正式 release              | 不检查产品更新    |
| 版本身份            | SemVer + release revision | 当前源码 revision |

两者可以同时运行，也可以由用户主动打开同一个项目目录；这不表示它们共享应用数据。

第一阶段不发布 Cinba Dev 的 rolling Pre-release 安装包。所有普通源码启动入口都属于 Cinba Dev，
不能再把 checkout 当作正式 Cinba 启动方式。要操作正式产品，应运行安装后的 Cinba。

## 8. 自包含运行时与 Pi 所有权

正式 Cinba 不依赖系统 Node、npm、Git 或全局 Pi：

- 每个 release 携带匹配的运行时；
- 每个 release 携带锁定版本的 Pi 代码；
- Core 直接使用 Cinba 内置 Pi，不探测或调用 PATH 中的 `pi`；
- 更新与失败回滚切换整套“Cinba 程序 + 运行时 + Pi”；
- 卸载 Cinba 时，内置 Pi 代码随程序删除。

用户独立安装的 Pi 保持完全独立。Cinba 不覆盖、更新或卸载它，也不继续共享 `~/.pi/agent`。
Cinba 的 Pi 数据进入 Cinba 自己的持久数据空间。

本设计不迁移当前本地或 VPS 的源码时代数据。第一个正式安装从全新布局开始；旧 `~/.cinba`、
`~/.pi/agent`、checkout release 和 deployment state 可以在安装器完成验收时另行清理，但本文不执行
清理。

## 9. 安装所有权

### 9.1 Per-user

Desktop 与 Headless 都是 per-user 安装：

- 每个操作系统用户只有一个正式 Cinba 安装；
- 不提供 system-wide 共享 Core；
- 不提供自定义程序安装目录；
- 不支持多个正式版本 side-by-side；
- 唯一并行身份是完全隔离的 Cinba Dev。

Desktop 不要求管理员权限。Headless 只安装给当前非 root 用户；以 root 运行普通安装时明确拒绝，
不创建或管理操作系统用户。

重复运行安装器时进入更新或修复已有安装。若 PATH 中已经存在不受 Cinba 管理的同名 `cinba`，安装器
不得静默覆盖，必须报告冲突。

Per-user 表示所有权与权限边界，不承诺第一阶段支持同一台机器上多个操作系统账号同时运行 Cinba。
每个账号可以独立安装和保存数据，但同一时刻只正式支持一个账号运行 Core/Sync。若端口已被其他账号
占用，应明确报告冲突，不能随机换端口，也不能读取、停止或修改另一个账号的 Cinba。

安装后保留一个很小的安装管理器，与可切换的版本化 payload 分离。它只负责安装完整性、candidate
切换、自动回滚和卸载，使主应用缺失或损坏时仍能完成清理。重复运行同版本或新版安装器即执行修复；
第一阶段不另设 `cinba repair`，`cinba doctor` 负责诊断并引导重跑安装器。

### 9.2 Windows 安装体验

Windows `.exe` 是无管理员权限的简洁用户级安装器：

- 安装到固定用户程序目录，不提供目录和组件选择；
- 注册到 Windows“已安装的应用”，创建开始菜单入口，不默认创建桌面快捷方式；
- 将 Cinba launcher 加入当前用户 `PATH`；
- 结束页默认提供并勾选 `Launch Cinba`；
- 重装、修复和更新复用同一事务式安装核心。

### 9.3 macOS 安装体验

macOS `.dmg` 中的 Cinba 首次运行时完成用户级自安装：

1. 用户从 DMG 双击 Cinba；
2. Cinba 说明将安装到 `~/Applications/Cinba.app`；
3. 用户确认后完成原子复制、CLI 配置和完整性检查；
4. 从固定路径重新启动 Cinba。

不要求拖入系统 `/Applications`，也不请求管理员权限。若 `~/Applications` 不存在则创建。Cinba 对
自己写入 shell 启动文件的内容使用明确标记块，卸载时只移除该标记块。

由于第一阶段不签名，Release notes 与安装说明应在 Gatekeeper 阻止首次打开时提供以下手工命令：

```sh
xattr -dr com.apple.quarantine "$HOME/Applications/Cinba.app"
```

Cinba 不自动执行该命令；它代表用户对所下载 GitHub Release 的主动信任。Release notes 以“系统设置 →
隐私与安全性”中的放行为首选路径，该命令作为等价的终端做法；不提供会因挂载卷名称变化而失效的
`/Volumes/...` 命令。Gatekeeper 在干净 macOS 上的实际拦截位置尚未实测，实测后按结果修订本节与
release notes。

### 9.4 安装完成行为

- Desktop 安装结束页默认提供并勾选 `Launch Cinba`；首次启动不自动启用 Background Core；
- Headless 安装结束后只报告成功和下一步，不自动进入全屏 TUI、不启动 Core、不创建后台组件；
- Provider、Core 和 Sync 配置都在用户首次进入产品后完成，不属于安装器表单。

## 10. Headless 首次安装入口

Linux Headless 的推荐体验是类似 Pi 的一行命令式 bootstrap；同时提供可检查的手工 artifact 路径。
推荐脚本来自正式 GitHub Release asset，不从实时 `master` 分支直接执行，也不需要新增 release/prod
分支。每个 release 都携带同名 `install.sh`；latest 入口只选择最新正式 release，脚本内部锁定自己
所属的具体版本，再下载该版本 manifest 与 artifact，避免发布竞争造成版本混装。在 asset 真正发布
之前，文档不展示一个看似可运行但尚不存在的安装 URL。

远程 bootstrap script 应保持短小、公开和可读，只负责：

1. 确认当前不是 root；
2. 检测 Linux x64；
3. 检查已有 Cinba 安装和 launcher 冲突；
4. 解析脚本锁定的正式 GitHub Release，获取 manifest 和 Headless artifact；
5. 校验下载；
6. 在临时目录调用 artifact 内的正式安装器；
7. 清理临时文件。

它不依赖系统 Node、npm 或 Git，不承担长期版本状态。正式安装器才拥有程序目录、launcher、更新和
卸载。

Linux launcher 固定为 `~/.local/bin/cinba`。第一阶段正式处理 Bash 与 Zsh：若该目录不在 `PATH`，
安装器在检测到的用户 shell 启动文件中写入可逆的 Cinba 标记块，并提示 `source` 对应文件或重新登录。
安装器不能声称已修改父 shell 环境。Fish 等其他 shell 不阻止安装，但只提供手工 PATH 指引。

第一阶段安装方式矩阵：

| 环境                | 推荐入口                | 备用入口                                    |
| ------------------- | ----------------------- | ------------------------------------------- |
| Windows x64         | Desktop 安装器          | 从 GitHub Release 手工下载同一安装器        |
| macOS Apple Silicon | Desktop 安装包          | 从 GitHub Release 手工下载同一安装包        |
| Linux x64           | 一行 Headless bootstrap | 手工下载 Headless artifact 并运行包内安装器 |
| 本地源码开发        | Cinba Dev 仓库启动流程  | 无                                          |

第一阶段不提供 PowerShell 一行安装、npm/pnpm/bun 全局安装、Homebrew、apt 或 winget。未来新增入口也
只能复用同一正式 artifact 和安装所有权，不能建立第二套版本布局。

## 11. 程序、持久数据和运行状态

正式安装在逻辑上分为四类：

```text
程序区
├── current release
├── candidate release（仅更新事务期间）
└── 每个 release 自带运行时与 Pi 代码

Cinba 持久数据
├── 会话
├── Settings
├── Cinba 管理的 Credentials
├── Core/Desktop profiles
└── Cinba 专用 Pi 数据

运行状态
├── PID、控制 token、锁
├── 日志
├── 下载缓存
└── 未完成的候选更新

Sync 权威数据
└── 独立的数据、授权、历史和加密 key
```

程序、持久数据、运行状态和 Sync 权威数据使用平台原生的 per-user 目录。第一阶段路径约定为：

| 平台    | 程序与 launcher                                                  | 持久数据                                                | 可重建状态、缓存与日志                                                                                                           |
| ------- | ---------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Windows | `%LOCALAPPDATA%\Programs\Cinba`；用户 PATH 中的 `cinba` launcher | `%LOCALAPPDATA%\Cinba\Data`                             | `%LOCALAPPDATA%\Cinba\State`、`Cache`、`Logs`                                                                                    |
| macOS   | `~/Applications/Cinba.app`；用户 PATH 中的 `cinba` launcher      | `~/Library/Application Support/com.soundoer.cinba/Data` | 对应 `Application Support` 状态区、`~/Library/Caches/com.soundoer.cinba`、`~/Library/Logs/com.soundoer.cinba`                    |
| Linux   | 固定的用户级版本化程序区；`~/.local/bin/cinba`                   | `${XDG_DATA_HOME:-~/.local/share}/cinba/data`           | `${XDG_STATE_HOME:-~/.local/state}/cinba` 与 `${XDG_CACHE_HOME:-~/.cache}/cinba`；配置遵循 `${XDG_CONFIG_HOME:-~/.config}/cinba` |

Sync 权威数据位于各平台 Cinba 持久数据中的独立 `Sync` 子树。安装器、`cinba doctor` 和设置界面必须
能显示最终解析后的实际路径。所有凭据、控制 token、迁移快照和 Sync key 使用仅当前用户可访问的文件
权限或 ACL；临时更新目录不得放宽这些权限。

更新只替换程序区，不把用户数据放进 release 目录。PID、锁、缓存和候选包可以重建，不属于备份所需
的用户数据。用户项目始终位于 Cinba 安装和删除范围之外。

Cinba Dev 使用独立应用标识落入完全不同的 Dev 目录。

正式版应用标识为 `com.soundoer.cinba`，开发版为 `com.soundoer.cinba.dev`。两者的程序状态、数据、
端口、服务名、锁和日志全部分离。旧 `~/.cinba`、`.cinba-sync` 和独立 Pi 的 `.pi` 不迁移，也不纳入
正式卸载范围。

## 12. Core 生命周期

Core 在所有平台只有两种运行模式：

### 12.1 On-demand

默认模式。有 Desktop、TUI、Web 或任务需要时启动；没有客户端和任务后按 idle 规则停止。

### 12.2 Background

用户明确启用后，Core 注册为当前用户的独立后台组件。没有客户端时仍运行。Desktop 或 TUI 关闭不
改变这个模式；用户以后重新打开 Desktop/TUI 设置即可切回 On-demand，Shell CLI 是故障恢复入口。

Desktop、TUI 和 Shell CLI 管理的是同一个本机 Core 设置。是否存在外部网络入口与 Core 运行模式
无关。

Windows/macOS 的 per-user Background 在用户登录后运行。Linux Headless 的 Background 承诺 SSH
断开后继续运行并在主机重启后恢复；实现为普通用户的后台服务。

平台适配分别使用：

- Windows Task Scheduler，以当前用户 interactive token 运行，不存储用户密码、不请求管理员权限；
- macOS user LaunchAgents；
- Linux `systemd --user`。

Core 与 Sync 分别注册自己的任务或 service，但都指向 Cinba 拥有的稳定 launcher，不能直接绑定某个
将被更新删除的 release 目录。

Linux 若缺少跨注销和重启所需的 linger，Cinba 可以在用户明确启用 Background 时请求一次受限的
管理员授权，只完成该账号持续用户服务所需的系统设置。Core 始终以普通用户运行。用户拒绝时不能把
状态标记成已成功 Background。linger 是账号级共享属性，卸载时不擅自关闭，只提示仍然存在。

## 13. Sync 生命周期与安装基础

Sync 随 Desktop 和 Headless artifact 一起分发，但默认不创建、不启动：

```text
Not created
└── Created
    ├── Disabled
    └── Enabled
        ├── On-demand
        └── Background
```

- `Not created`：只有安装的程序代码，没有 Sync 权威数据；
- `Disabled`：保留权威数据，但不自动启动；
- `On-demand`：由本机 Desktop/TUI 在需要时启动，不承诺远程设备随时可达；
- `Background`：作为独立后台组件运行，Desktop/TUI 关闭后继续可用。

Core 与 Sync 复用共同的后台组件管理基础，包括注册、start/stop/status、安全停止、健康检查、日志、
更新和卸载适配；但它们始终注册为两个独立受管进程，使用不同端口、数据目录和健康检查，生命周期不
绑定。

本机 GUI Sync 第一实施切片的具体 tray 托管规则继续以下游 Sync 产品体验规格为准。本文只要求安装
基础允许以后在同一套机制上增加 Headless Background Sync，而不是创建第二套 bootstrap。

## 14. 外部网络边界

VPS 不是一种安装类型，也不由 Cinba 检测。VPS、普通 Linux、NAS 和家用主机使用同一个 Headless
artifact、安装流程、目录和更新机制。

完成 Headless 安装表示本机 CLI、TUI 和 loopback Core 可用，不表示已建立远程入口。Cinba 不负责：

- 安装或配置 Tailscale、Caddy、Nginx；
- 申请域名或证书；
- 修改云防火墙、系统防火墙或路由；
- 自动开放 LAN 或公网端口；
- 卸载用户管理的外部网络设施。

Cinba 只保证 Core/Sync 默认使用安全的本机边界、能在用户提供的 HTTPS reverse proxy 后正确运行、
提供健康和连接诊断，并如实显示当前可达性。

## 15. 更新发现与下载

Desktop 和 Headless 都只管理当前设备上的 Cinba 安装，不通过普通 Core、Web 或 Sync 管理连接远程
升级其他主机。

更新检查规则：

- Desktop 或 TUI 启动后异步检查，整台用户安装最多每 24 小时一次；
- Desktop、TUI 与 CLI 共享检查时间、candidate 和下载缓存，不重复下载或互相竞争；
- 设置中提供手动检查，`cinba update` 可随时显式检查；
- Background Core/Sync 不为更新单独运行定时轮询；
- 自动检查失败不影响正常使用且不主动打扰；显式 `cinba update` 应显示具体错误；
- 不发送设备 ID、统计或遥测。

发现新 release 后默认自动下载当前平台 artifact，但不自动安装或重启：

```text
发现新版本
    ↓
后台下载并校验 candidate release
    ↓
Update ready
    ↓
Install and restart / Later
```

下载支持取消、失败重试和继续；`Later` 保留已经验证的 candidate，不重复下载；更新的 release 可以
取代尚未安装的旧 candidate。设置中允许关闭自动下载。

Updater 先按 manifest 判断系统兼容性，只下载当前平台 artifact。Background Core/Sync 永远不会自行
访问 GitHub、下载或安装更新。

## 16. 更新激活与失败恢复

Desktop 的手工安装包升级与 Headless 的产品内更新使用同一版本化安装核心：

1. 校验 release 与本机平台；
2. 把新版本准备为 candidate release；
3. 检查数据格式；
4. 等待 Core 和 Sync 没有不可中断任务；
5. 安全停止需要重启的本机组件；
6. 原子切换完整程序、运行时和内置 Pi；
7. 启动并验证；
8. 成功后清理旧程序；失败则自动恢复更新前状态。

更新不允许只替换 Desktop、CLI、Core 或 Sync 中的一部分。确认界面应准确说明将重启的当前本机组件。

下载可以发生在 agent 任务运行期间，但安装不能强制中断活动任务。用户确认安装后若仍有不可中断工作，
界面显示“更新已准备好，等待任务结束”，回到安全空闲状态后再次询问；希望立即更新的用户需先自行
停止任务。普通产品入口不提供“强制杀掉任务并更新”。

候选版本的最低验证集包括 artifact 与版本、内置 Node、CLI、TUI 原生依赖、Pi RPC、extensions 和
静态资源。Core 原本在运行时，切换后恢复并验证 revision、HTTP 健康和 WebSocket；原本关闭时只做
离线验证，不擅自启动。Sync 未创建时完全不创建数据目录；已创建但关闭时只做只读格式检查；原本运行
时进入维护、drain、恢复并验证。更新前的 On-demand/Background 与运行状态必须被保留。

成功或失败后回到发起更新的表面：Desktop 重新打开 Desktop，TUI 退出旧进程后重新进入 TUI，CLI
报告结果后退出；原本运行的 Background 组件恢复原状态。

第一阶段不提供用户可见的 previous release 或 Roll back 按钮，也不长期保留任意历史版本。用户主动
降级时，从 GitHub Releases 下载旧版安装包；安装器必须检查数据兼容性，不兼容时明确阻止。

## 17. 数据迁移与自动回滚

每个 release 声明自己支持的数据格式。需要迁移时：

- 修改前创建受保护的数据快照；
- 新版本在对用户开放前完成迁移和健康验证；
- 安装、迁移或启动验证失败时，自动恢复旧程序和更新前快照；
- 新版本成功运行并产生新数据后，不再自动恢复旧快照；
- 旧版无法读取新格式时阻止直接降级；
- 用户若明确恢复旧快照，必须说明会丢失快照之后产生的数据。

因此自动回滚只保证更新激活事务失败不会装坏 Cinba，不承诺任意时间无损降级。

## 18. 跨版本连接兼容

不同设备不会同时更新。产品版本之外还需独立的协议版本与能力协商：

- Web/TUI/Desktop 与 Core 的握手报告产品版本、协议版本和能力；
- Core 与 Sync 的协议使用同样原则；
- 每个正式 release 至少测试并支持与紧邻上一 release 的双向连接；
- 新功能在旧端不可用时隐藏或明确提示需要更新；
- 超出兼容范围时在握手阶段明确拒绝并说明需要更新哪一端；
- 不把不兼容表现成随机断线、白屏或未知消息错误。

相邻 release 兼容保证共同功能正常工作，不要求不同版本拥有完全相同的功能，也不承诺任意古老版本
永久兼容。远程 Core 提供的 Web UI仍由该 Core 自己提供，天然与服务端版本匹配。

## 19. 卸载与删除

普通卸载负责：

- 等待或拒绝中断活跃任务；
- 停止 Cinba 管理的 Core 和 Sync 进程；
- 移除 Cinba 创建的后台组件注册；
- 删除 Desktop、CLI、TUI、Core、Sync、内置运行时和内置 Pi 代码；
- 删除 launcher、版本目录、缓存、锁和未完成 candidate；
- 不触碰用户项目、独立 Pi、Tailscale、Caddy 或其他外部设施。

普通卸载默认保留：

- 会话、Settings、Credentials 和 profiles；
- Cinba 专用 Pi 数据；
- Sync 权威数据。

正式入口统一为：

- `cinba uninstall`：普通卸载并保留上述持久数据；
- `cinba uninstall --purge`：卸载程序并永久删除 Cinba 持久数据、Sync authority 和凭据，必须进行
  交互式二次确认；
- 自动化环境使用 purge 时还需提供专门的非交互确认参数，单独一个通用 `--force` 不足以授权数据删除；
- Desktop 对应“卸载 Cinba”和单独的“卸载并删除所有数据”，危险入口不作为默认按钮；
- Windows 系统卸载入口始终执行普通卸载。

普通卸载后重新安装，应自动识别并复用保留的会话、Settings、Credentials、profiles、Pi 数据和 Sync
authority；若保留数据来自更新且旧安装器无法读取，必须阻止旧版安装，不能静默损坏或降级数据。

Desktop 使用平台或设置入口；Headless 在 TUI Host 设置中提供卸载入口，Shell CLI 提供故障恢复等价
入口。运行中的 TUI 将卸载交给独立安装管理器后退出，不能一边运行一边删除自己。

macOS 的正式卸载入口是 Desktop 设置或 `cinba uninstall`。若用户只删除 `Cinba.app`，稳定 launcher
应发现主程序完整性失效并停止 Background 组件；仍然存在的 `cinba uninstall` 可以清理辅助文件，无需
先重新安装。卸载只移除 Cinba 自己写入的 PATH 标记块。

Linux 卸载不擅自关闭账号级共享的 linger，只提示该系统设置仍然存在。

## 20. 旧部署链的退役

`packages/deploy` 不是新分发体系的长期组件。新安装器稳定后，它当前与 Git checkout、`prod` 分支、
`npm ci`、VPS worktree、定时 fetch 和旧 launcher 绑定的部分全部删除。以下经过验证的能力迁入新的安装
管理核心，而不是随包保留：

- 更新锁与事务状态机；
- Core/Sync drain 和安全停止；
- candidate 隔离、原子切换与健康验证；
- Sync 原运行状态恢复；
- 失败回滚。

Core 当前为了旧部署流程暴露的 deployment status 不应继续让 Core 承担产品更新职责；本地安装管理器
拥有更新状态，并通过共享本机接口呈现给 Desktop/TUI/CLI。新体系在 Windows、macOS 和干净 Linux
主机实机验收后，才删除 `packages/deploy`、旧 systemd 单元、`scripts/promote.ts`、`prod` 分支和
`cinba-prod` skill。旧 VPS 不迁移，届时清空后按 Headless 新装流程作为验收环境。

## 21. 第一实施边界

第一阶段需要形成完整纵向路径：

- 单一 SemVer 与 tag 驱动 GitHub Release；
- 首个正式版本 `v0.1.0`，正式 release 启用 immutable；
- Windows x64、macOS Apple Silicon、Linux x64 三个平台 artifact；
- Desktop per-user 安装并默认提供 `cinba`；
- Windows 用户级 `.exe` 与 macOS 用户级 `.dmg` 自安装体验；
- Linux 一行 bootstrap 与手工 artifact 备用入口；
- 自包含运行时和内置 Pi；
- Cinba / Cinba Dev 完整隔离；
- 平台原生程序、持久数据、运行状态和 Sync 数据边界；
- Core On-demand / Background；
- Core 与 Sync 独立后台组件管理基础；
- 前台低频检查、自动下载、用户确认安装；
- 安全 draining、候选验证、数据快照和失败恢复；
- Desktop 与 Headless 卸载；
- 普通卸载保留数据，显式 purge 永久清除；
- 相邻 release 协议兼容检查；
- 新体系实机验收后删除 `prod` 分支和旧部署链。

第一阶段明确不包含：

- 平台代码签名或 macOS notarization；
- Desktop portable；
- Windows ARM64、Intel Mac、Linux ARM64；
- Windows Server、Alpine/musl 与多操作系统账号同时运行；
- Windows Headless；
- npm、pnpm、bun、Homebrew、apt、winget 安装；
- Cinba Dev Pre-release artifact；
- 静默自动安装或自动重启；
- 用户可见的版本历史与一键回滚；
- 远程主机升级；
- Tailscale、Caddy、TLS、域名或防火墙自动配置；
- 旧源码时代本地/VPS 数据迁移。

## 22. 验收原则

实施完成后至少验证：

- 三个平台从没有 Node、npm、Git 和全局 Pi 的用户环境完成安装；
- Windows 10/11 x64、macOS 13.5+ Apple Silicon、Ubuntu 22.04/24.04 x64 的支持矩阵通过；
- artifact 完全自包含，离线复制后安装不访问 npm、Node 官网或 pi.dev；
- 安装后的 Desktop 和 Headless 使用同一 release 版本和匹配组件；
- `cinba` launcher 不依赖下载目录或源码 checkout；
- Cinba 与 Cinba Dev 同时运行且不共享数据、端口、锁或服务标识；
- 已独立安装 Pi 时，Cinba 不覆盖它，也不读取其全局数据；
- On-demand 与 Background Core 在 Desktop 和 Headless 上符合各自承诺；
- Core 与 Sync 可以分别使用不同生命周期；
- Linux Background 在 SSH 断开和重启后恢复，Core/Sync 仍以普通用户运行；
- 更新下载不会自动安装，用户确认后才进入 draining 和重启；
- 活动任务不会被安装器强制终止；
- 候选启动或数据迁移失败会恢复更新前程序与数据；
- 新旧相邻 release 的客户端/Core/Sync 兼容矩阵通过；
- 普通卸载后重新安装能继续使用保留的持久数据；
- 普通卸载不删除 Sync 权威数据、用户项目、独立 Pi 或外部网络配置；
- purge 只有在明确二次确认后才删除 Cinba 与 Sync 持久数据；
- 干净 VPS 使用与普通 Linux 相同的 Headless 安装入口完成本机运行，不存在第二套 VPS bootstrap。
