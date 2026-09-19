# Cinba 产品分发体系实施计划

日期：2026-09-17

最后更新：2026-09-19

状态：代码实施完成，Draft Release 已从 `f4025b4` 重建；Windows 当前用户与 Linux 容器探针完成，
Linux 无 systemd/linger 处理待修复；等待 macOS 重测、干净环境验收与正式发布

对应规格：`docs/specs/2026-09-17-cinba-product-distribution-design.md`

## 实施进度

阶段 0—10 的仓库内代码已经完成：统一 payload、事务安装、后台服务、CLI、Desktop/Headless artifact、
更新协调、正式 Release workflow、协议兼容和旧部署链退役均已落地。根产品版本已进入 `0.1.0`，
`npm run check` 在本地通过。面向 `master` 的 push 和 pull request 现由 Windows、macOS、Linux
三平台日常 CI 自动执行同一 merge gate，首次运行已通过。

发布基础和首轮外部验证已经完成：

- GitHub Immutable Releases 已启用；
- **Prepare product release** 已从锁定 revision 在三平台完成检查、构建、attestation 和 Draft Release；
- artifact、manifest、校验值、双语说明和六个 Release asset 已完成复核；
- Apple Silicon macOS 当前用户已完成安装、同版本修复、On-demand/Background 往返、普通卸载和
  保留数据重装（基于首个 Draft，需用重建后的 Draft 重测）；
- Windows 当前用户探针发现的 Background 交接、卸载与重装竞争、Dev 隔离、Desktop/TUI 卸载入口等
  问题已修复并在重建后的 Draft 上复测通过；
- Linux 容器探针完成离线安装、On-demand、Background、重启恢复、卸载与 purge 的验证，发现无
  systemd 时无法卸载、无 linger 时诊断不足两项待修复。

仍未完成的是必须依赖真实目标系统或后续版本的验收，不把局部探针误记成完整通过：

- 在 Windows 干净普通用户、macOS 干净账号、Ubuntu 22.04/24.04 与清空后的 VPS 上完成从零安装；
- 完成 SmartScreen、Gatekeeper、真实 SSH 与主机重启恢复和真实更新失败恢复；
- 首个后续版本存在后，执行真实 `N-1 → N` 更新与双向连接兼容矩阵；
- 人工复核剩余实机结果后正式发布 `v0.1.0`，确认 immutable 状态和 updater 发现行为；
- 正式发布并完成新链验收后，再删除远端 `prod` 分支。

逐项记录见 `docs/notes/2026-09-18-cinba-product-distribution-verification.md`。

## 目标与完成标准

把当前依赖 Node、源码 checkout、`npm install`、`npm link` 和手工 systemd 的运行方式，替换为可重复
构建、安装、更新和卸载的正式产品分发体系：

- 一个 `vX.Y.Z` 对应同一 Git revision 和完整的 Windows、macOS、Linux 产物；
- Windows/macOS Desktop 与 Linux Headless 共享版本、payload 规范、安装管理核心和后台组件抽象；
- 正式安装不依赖系统 Node、npm、Git 或独立 Pi；
- `cinba` 在所有安装形态中同时承担 TUI 默认入口和产品管理 CLI；
- 程序、持久数据、运行状态、Sync authority 与 Cinba Dev 完全分离；
- 更新具备下载校验、drain、原子切换、健康验证、数据快照和失败回滚；
- Core 与 Sync 可独立使用 On-demand 或 Background；
- 普通卸载保留数据，显式 purge 才永久删除；
- GitHub Actions 能从一个锁定 SHA 产出并验证完整 draft Release；
- Windows 10/11 x64、macOS 13.5+ Apple Silicon、Ubuntu 22.04/24.04 x64 完成实机验收；
- 新体系验收后删除 `packages/deploy`、`prod` 分支与旧 VPS 部署链；
- 每个阶段保持 `npm run check` 通过。

## 实施原则

1. 产品规格已经确定；纯技术选型由实现负责。只有新增 runtime dependency，或实现发现会改变用户
   体验、安全边界和长期架构时，才重新请求确认。
2. 先固定纯数据契约和目录所有权，再写会修改真实安装的代码；事务核心先用临时目录测试。
3. 安装管理器不依赖当前 release 才能执行切换、回滚和卸载；版本化 payload 不拥有安装指针。
4. 正式 payload 中所有可执行入口只通过共同 launcher 启动，不能重新依赖源码仓库路径。
5. Core、Sync、Desktop 和 TUI 不各自实现 updater 或 service adapter；它们只消费安装管理器公开的
   本机状态和操作。
6. Release manifest、artifact inventory、事务状态和服务描述均严格解析；未知版本 fail closed。
7. 所有测试使用临时目录和注入的平台信息，不写真实 PATH、LaunchAgent、Task Scheduler、systemd 或
   用户数据。
8. 先保留旧源码运行链供开发使用；正式 launcher 可用后，再把全部 checkout 入口统一切换为
   Cinba Dev 身份。
9. 不迁移旧 `~/.cinba`、`.cinba-sync`、`.pi` 或 VPS checkout 数据，也不在实现阶段主动删除它们。
10. 每个阶段形成独立、可回滚的 Conventional Commit；正式发布前运行完整 merge gate 和三平台实机
    验收。

## 预期 package 与文件形状

文件名可在实现中小幅调整，但依赖方向保持如下：

```text
packages/
├── installer/                       # 稳定安装管理核心，不依赖 Desktop
│   ├── src/
│   │   ├── manifest.ts              # release manifest 严格解析
│   │   ├── platform.ts              # 正式 target 与系统下限
│   │   ├── paths.ts                 # 程序、数据、状态、缓存、日志布局
│   │   ├── inventory.ts             # artifact 内文件清单与校验
│   │   ├── transaction.ts           # stage / switch / verify / rollback
│   │   ├── installation-store.ts    # current/candidate/事务状态
│   │   ├── uninstall.ts             # preserve 与 purge 边界
│   │   └── cli.ts                   # 独立 installer 子进程入口
│   └── src/services/
│       ├── service-manager.ts       # Core/Sync 共同抽象
│       ├── windows-task.ts
│       ├── macos-launch-agent.ts
│       └── linux-systemd-user.ts
├── product-runtime/                 # release 内入口与资源定位，不拥有更新
│   └── src/
│       ├── identity.ts              # Cinba / Cinba Dev
│       ├── release.ts               # version/revision/protocol identity
│       └── entries.ts               # Core/TUI/Sync/Desktop 入口定位
├── core-manager/                    # 消费 product-runtime，不再推导 checkout
├── desktop/                         # 消费 installer 状态和操作
└── deploy/                          # 过渡期保留，最终删除

scripts/
├── build-payload.ts                 # 构建标准平台 payload
├── build-manifest.ts                # 生成 manifest 与 inventory
├── release.ts                       # 明确的正式发版入口
└── install-bootstrap/               # 生成 release 中的 install.sh

.github/workflows/
└── release.yml                      # 三平台原生 matrix 与 draft 发布
```

若实际证明 `product-runtime` 只有极少逻辑，可在不破坏依赖方向的前提下并入 `installer`；不能让
Desktop、Core 或 `scripts/launch.ts` 成为分发契约的唯一拥有者。

## 阶段 0：当前实现审计与打包探针

### 改动

- 记录所有依赖 Git checkout、`process.execPath`、源码 `.ts` 入口、`node_modules`、`~/.cinba`、`~/.pi`
  与 `packages/deploy` 的运行路径；
- 枚举 Pi、TUI、Electron、WASM、原生模块、动态 extensions 和静态资源；
- 在 Windows、macOS、Linux 各做一次最小 payload 探针，证明私有 Node 能启动 CLI/Core/TUI，Pi RPC
  能加载资源；
- 验证 Electron payload 与独立 Node runtime 共存，不错误复用 Electron 的 Node；
- 比较可选的 Desktop 打包器和 Windows per-user 安装器，只选择满足固定目录、静默升级接口和独立
  卸载管理器的最小组合；
- 若选型需要新增 runtime dependency，先停止并请求用户确认。

### 完成条件

- 每个必须复制而不能 bundle 的资源都有来源和目标；
- 三个平台的构建必须在原生 runner 执行已有证据；
- 技术选型不会引入第二套 updater、版本目录或卸载语义。

## 阶段 1：分发契约、平台目标与目录布局

### 改动

建立 `@cinba/installer` 的无副作用基础模块：

- 正式 target：`windows-x64`、`macos-arm64`、`linux-x64-gnu`；
- 第一版系统下限和平台探测结果；
- versioned release manifest v1 的严格 parser；
- artifact 文件名、字节数、SHA-256、协议版本和数据格式版本；
- Windows/macOS/Linux 的程序、数据、Sync、状态、缓存、日志与 launcher 路径；
- 路径解析显式接收 home、环境变量和 platform，测试不能读取真实用户目录；
- 对外只返回已规范化的绝对路径，不允许持久数据落入 release 目录。

### 测试

- 三个正式 target 与所有排除平台；
- manifest 合法输入、缺字段、额外字段、错误 hash、重复 target、未知 schema；
- SemVer、revision、协议和数据格式边界；
- 三个平台默认路径与 XDG override；
- Cinba 与 Cinba Dev 的应用标识和所有路径均不相等；
- Sync authority 必须位于持久数据树，缓存、日志和 transaction 不得位于其中；
- 任意 release version 不改变用户持久数据路径。

### 完成条件

后续 payload、installer、updater、service manager 和 UI 只消费同一契约，不再各自拼目录与 target 名。

## 阶段 2：产品身份与可搬运 payload

### 改动

- 建立 `@cinba/product-runtime`，显式区分 `Cinba` 与 `Cinba Dev`；
- release identity 来自构建注入的 version、revision、protocol 和 data format，不在运行时调用 Git；
- 为 CLI、TUI、Core、Sync、Desktop 建立 release-relative 入口；
- 构建 payload 时复制私有 Node、Pi package、WASM/native 资源、extensions 与 Web 静态文件；
- 生成 inventory 并在干净临时目录使用私有 Node 完成 smoke test；
- 源码 `npm start`、`npm run dev`、`npm run tui`、`npm run desktop` 全部成为 Cinba Dev，并使用 Dev
  app id、目录、端口、锁与服务名。

### 完成条件

删除或移动源码 checkout 后，复制出的 payload 仍可运行 CLI、TUI、Core 与 Sync；正式运行路径不调用
Git、不查找根 `node_modules`、不读取独立 Pi 数据。

## 阶段 3：安装状态与事务核心

### 改动

- 建立 current、candidate、transaction 和受保护数据快照模型；
- 安装流程实现 stage、inventory 验证、兼容检查、切换、启动验证、commit 和 rollback；
- 同版本重跑进入修复，旧版本安装先检查数据格式；
- 安装锁避免 Desktop、TUI 和 CLI 同时更新；
- 安装管理器自身使用稳定位置，不能位于待删除 release；
- normal uninstall 与 purge 使用不同授权类型，purge 的非交互确认不能复用通用 force。

### 测试

- 首次安装、更新、同版本修复、失败回滚和崩溃恢复；
- candidate 校验失败不修改 current；
- 指针切换、健康验证和清理任一步失败后的确定状态；
- 数据迁移失败恢复旧程序和快照；
- 普通卸载保留数据，purge 删除且只删除 Cinba 所有范围；
- 用户项目、独立 Pi、外部网络配置和另一个 OS 用户数据永不进入删除集合。

## 阶段 4：Core/Sync Background 服务框架

### 改动

- 定义 `not-installed / disabled / on-demand / background` 状态与幂等操作；
- Core、Sync 使用同一 service manager API，但不同 service id、参数、端口、日志和健康检查；
- Windows 实现当前用户 Task Scheduler；macOS 实现 user LaunchAgent；Linux 实现 `systemd --user`；
- Linux 在用户选择 Background 时检测 systemd 与 linger，仅在需要时给出受限授权步骤；
- service 始终指向稳定 launcher，由 launcher 解析 current release；
- 更新前记录运行模式和运行状态，更新后精确恢复。

### 完成条件

三平台 Background 都不依赖 Desktop/TUI 存活；Core 与 Sync 可独立切换，卸载能清理注册且不擅自关闭
共享 linger。

## 阶段 5：统一 CLI、诊断与更新入口

### 改动

- 保持 `cinba` 默认进入 TUI；
- 增加 `cinba update`、Background 管理、`cinba uninstall` 与 `--purge`；
- `cinba doctor` 从 checkout 诊断改为 release、inventory、路径、服务、权限和平台诊断；
- 自动检查状态、candidate 和错误由安装管理器共享；
- 移除普通产品对源码仓库、npm link 和系统 Node 的描述。

### 完成条件

Desktop 与 Headless 使用相同命令语义；主程序损坏时稳定 launcher 仍能调用卸载管理器。

## 阶段 6：Desktop 打包与安装体验

### Windows

- 生成无管理员权限的 `.exe`；
- 固定安装到 `%LOCALAPPDATA%\Programs\Cinba`；
- 注册“已安装的应用”、开始菜单与用户 PATH，不默认创建桌面快捷方式；
- 系统卸载入口只执行普通卸载；
- SmartScreen 提示与 Release notes 一致。

### macOS

- 生成 Apple Silicon `.dmg`；
- DMG 内首次运行自复制到 `~/Applications/Cinba.app` 并重新启动；
- 配置用户 CLI 和可逆 PATH 标记块；
- 提供 Gatekeeper 与 `xattr` 手工说明，不自动清除 quarantine；
- 手工删除 `.app` 后 Background 自停，稳定 launcher 仍能卸载辅助文件。

### 完成条件

全新用户不需要管理员权限即可完成安装、启动、更新和卸载；Desktop 安装后新终端能直接运行
`cinba`。

## 阶段 7：Linux Headless artifact 与 bootstrap

### 改动

- 生成 Linux x64 glibc 自包含 artifact 与包内 installer；
- 安装到固定 per-user 程序区，创建 `~/.local/bin/cinba`；
- Bash/Zsh PATH 使用可逆标记块，其他 shell 给出手工指引；
- 以 root 运行时拒绝，不创建用户、不配置 Tailscale/Caddy/firewall；
- 每个 release 生成版本锁定的 `install.sh` asset；latest 只解析正式 release 入口；
- 手工 artifact 安装与一行 bootstrap 调用同一个 installer。

### 完成条件

干净 Ubuntu 22.04/24.04 和原 VPS 清空后的主机都通过同一流程安装；安装结束不自动启动 TUI、Core、
Sync 或 Background。

## 阶段 8：更新 UI 与前台协调

### 改动

- Desktop/TUI 启动时最多每 24 小时异步检查；显式 `cinba update` 绕过低频限制；
- 默认后台下载并校验，不静默安装；
- 活动任务使安装保持 ready/waiting，不提供普通强制终止；
- Desktop/TUI 展示版本、系统不兼容、下载进度、ready、draining、成功与 rollback 结果；
- 更新完成后回到发起表面，恢复 Core/Sync 原生命周期状态。

### 完成条件

多个前台同时打开不会重复下载或竞争事务；Background 服务本身不访问 GitHub。

## 阶段 9：正式 Release 流水线

### 改动

- 根 package version 成为唯一产品版本，首个正式版本为 `0.1.0`；
- GitHub Actions 从锁定 SHA 在三平台原生 runner 构建、测试和 attestation；
- 生成 release manifest、SHA-256、inventory、双语安装说明和准确 artifact 名；
- 只有完整集合通过才创建 tag、组装 draft 并允许人工发布；
- 正式发布启用 immutable，updater 忽略 draft 与 prerelease。

### 完成条件

从一次明确发版操作得到完整 `v0.1.0` draft；人工复核后发布，所有安装入口只读取该正式 Release。

## 阶段 10：协议兼容、旧部署链退役与实机验收

### 改动

- 握手加入产品版本、协议版本和 capabilities，相邻 release 做双向矩阵；
- 将 `packages/deploy` 中仍有价值的 lock、drain、verify、rollback 逻辑迁入 installer；
- Core 删除 `/deployment-status` 和 `@cinba/deploy` 依赖；
- 删除旧 systemd、`scripts/promote.ts`、`prod` 分支流程与 `cinba-prod` skill；
- README 改为正式安装优先，源码部分只描述 Cinba Dev；
- 按规格逐项完成 Windows、macOS、Linux、离线安装、更新失败、普通卸载、purge 和重装验收。

### 完成条件

- `npm run check` 通过；
- 三平台真实 artifact 完成从零安装和 `N-1 → N` 更新；
- 旧 VPS 清空后使用正式 Headless artifact 重建；
- 仓库不再包含或文档化第二套 Git/VPS deployment product path；
- 产品规格中的验收清单全部有自动化测试或实机记录。

## 提交顺序

计划采用以下小步提交，不把打包、安装、服务和发布混成一个不可审查的提交：

1. `docs(deploy): plan product distribution implementation`
2. `feat(installer): define release and platform contracts`
3. `feat(runtime): build relocatable product payload`
4. `feat(installer): add transactional installation manager`
5. `feat(installer): manage background components`
6. `feat(cli): manage installed Cinba lifecycle`
7. `feat(desktop): package user-level installers`
8. `feat(installer): bootstrap Linux headless installs`
9. `feat(desktop): coordinate product updates`
10. `ci(release): publish immutable product artifacts`
11. `refactor(deploy): retire checkout deployment path`

实际阶段若需拆得更细可以增加提交，但不能跨过对应测试和验收门槛。
