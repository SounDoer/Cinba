# Cinba 产品分发验收记录

日期：2026-09-18

最后更新：2026-09-19

状态：Draft 已从 `338a730` 重建；Windows 复测发现 Desktop/TUI 发起的卸载因安装锁自冲突而不生效，
阻断发布；macOS 需用新 Draft 重测，其余平台、干净账号和正式发布待验收

对应规格：`docs/specs/2026-09-17-cinba-product-distribution-design.md`

对应计划：`docs/plans/2026-09-17-cinba-product-distribution.md`

## 已由自动化验证

- 根 `package.json` 是唯一产品版本源，当前版本为 `0.1.0`；
- Windows x64、macOS Apple Silicon、Linux x64 使用同一 release/payload/manifest 契约；
- payload 包含受控 Node 运行时、Pi、Core、TUI、Desktop（适用平台）和共同 CLI；
- artifact inventory、release manifest、大小、SHA-256、平台下限和 revision 均有严格解析与校验；
- 安装事务、current 指针、数据快照、失败恢复、候选清理和卸载边界具有临时目录测试；
- Windows 用户级安装注册、macOS 自安装 DMG、Linux archive/bootstrap 具有生成与契约测试；
- Core 与 Sync 复用服务管理抽象，但保留独立生命周期状态；
- Desktop/TUI 自动检查、后台下载、用户确认、活动任务等待、handoff、重启和错误状态具有测试；
- Core 首条连接消息携带产品版本、revision、protocol version 和 capabilities；相邻产品版本在协议与
  能力相容时双向允许，协议不相容时在进入 connected 前拒绝；
- Cinba 与 Cinba Dev 的目录、端口、锁、服务标识和 Pi 数据边界分离；
- 普通卸载保留持久数据，`--purge` 需要明确确认；独立 Pi 和外部网络配置不属于删除范围；
- 旧 `packages/deploy`、`/deployment-status`、旧 systemd/Caddy 文件、promotion 脚本和 `cinba-prod`
  skill 已从仓库删除；
- README 已改为正式安装优先，源码入口只描述 Cinba Dev；
- 面向 `master` 的 push 和 pull request 已启用 Windows、macOS、Linux 三平台日常 CI；首次
  [CI 运行](https://github.com/SounDoer/Cinba/actions/runs/35372354729) 全部通过；
- 本轮最终 `npm run check` 通过：953 个单元测试（951 个通过、2 个平台限定跳过）、11 个端到端测试
  和 Web、Desktop、Sync Web 构建全部成功。

## 当前 Windows 构建探针

在 Windows 11 x64 上从提交 `d0265e870b6d6da5487995736585948f3704fa2b` 执行
`npm run build:windows-artifact` 成功：

- payload 构建并通过 inventory 校验；
- release bundle 在隔离临时 home 中完成安装并实际启动 `Cinba 0.1.0`；
- NSIS 生成 `Cinba-0.1.0-windows-x64.exe`，大小 178,152,432 bytes；
- 本机构建文件 SHA-256 为
  `bf66593bde0061d37a16afe3d9b6045c41eba1287f6e02275bd79ed5a216c756`；
- Authenticode 状态为 `NotSigned`，与第一阶段明确不签名的产品边界一致。

这只证明当前 Windows 主机构建链和隔离 bundle 安装可用，不等同于在干净 Windows 用户账号中实际
点击 `.exe` 完成安装、PATH/Start Menu 注册、更新和卸载，因此下方 Windows 实机项目仍保持未勾选。

## 首个正式 Release workflow

GitHub Actions 已从提交 `8eec5f15e0dd66e17804c65ed4aedc37bdd0743e` 成功完成
[Prepare product release](https://github.com/SounDoer/Cinba/actions/runs/35368865710)：

- Windows、macOS、Linux runner 均通过完整 `npm run check`，构建并上传原生 artifact；
- Draft Release `Cinba 0.1.0` 已创建，尚未正式发布，也尚未创建不可变 Git tag；
- 六个预期资产齐全，`cinba-release.json` 的版本、revision、平台下限、文件大小和 SHA-256 与
  GitHub asset digest 一致；
- 三个平台 artifact、`install.sh`、`cinba-release.json` 和 `SHA256SUMS` 的 GitHub artifact
  attestation 均可按 digest 查询；
- 中英双语 Release notes 包含准确文件名、系统下限、SmartScreen、Gatekeeper、`xattr`、Linux
  bootstrap、手工安装和更新说明。

正式发布前仍需完成三平台真实用户安装验收；Draft 不能因为自动化通过就直接发布。

## 当前 macOS 安装探针

在 Apple Silicon macOS 15 当前用户上下载 Draft DMG，核对 GitHub asset digest 后完成了首次安装、
同版本修复、普通卸载和保留数据重装：

- Cinba 安装到 `~/Applications/Cinba.app`，`~/.local/bin/cinba` 在新 Zsh 中可直接解析；
- `cinba version` 报告 `0.1.0` 和 release revision
  `8eec5f15e0dd66e17804c65ed4aedc37bdd0743e`；
- `cinba doctor` 对平台、内置 Node 24.20.0、payload、current pointer 和 Core 全部报告通过；
- Desktop 与 On-demand Core 能从正式安装目录启动；
- Core 可从 On-demand 切换到健康的 Background LaunchAgent，再切回 On-demand；切回后 plist 被清理；
- 同版本修复安装保留了已有正式数据和服务状态；
- 普通卸载移除了应用、launcher、release、installer 和 LaunchAgent，保留的 Core 配置哈希不变；
  从同一 Draft DMG 重装后版本、PATH、payload、current pointer、Core 和原配置均恢复正常。

这台机器装有开发工具，且尚未执行 Gatekeeper 阻止场景、purge 和干净账号重装，因此下方完整
macOS 验收项仍保持未勾选。

## 当前 Windows 安装探针

2026-09-19 在 Windows 11 Pro 22631 x64 的当前**非管理员**用户上，用 `gh` 下载 Draft 中的
`Cinba-0.1.0-windows-x64.exe`，SHA-256 `2ada34c2…d794` 与 `SHA256SUMS`、GitHub asset digest
和 manifest 大小一致。安装向导通过 UI Automation 驱动真实 GUI。该账号装有 Node、Git、全局 Pi
和旧 `npm link`，不是干净账号；文件经 `gh` 下载、无 Zone.Identifier，因此未观察 SmartScreen。

符合规格的部分：

- 无 UAC、无目录或组件选择，直接进入安装；结束页 `Launch Cinba` 默认勾选并启动 Desktop；
- 程序位于 `%LOCALAPPDATA%\Programs\Cinba`，数据位于 `%LOCALAPPDATA%\Cinba\Data`；HKCU 注册
  `Cinba 0.1.0 / SounDoer`，开始菜单有 `Cinba.lnk`，无桌面快捷方式，系统 PATH 未改动，用户
  PATH 追加 `...\Programs\Cinba\bin`；
- 正式 launcher 的 `version`、`doctor`（内置 Node 24.20.0、payload、activation、Core）通过；
- Core 端口空闲时切换 Background 注册 `\Cinba\Core`（当前用户、Interactive、Limited、登录触发、
  指向稳定 launcher）；Desktop 从开始菜单打开后连接该服务，关闭 Desktop 后 Core 继续运行；
  切回 On-demand 后任务删除、Core 停止；
- Desktop 关闭时的普通卸载约 10 秒完成，移除程序、注册、PATH、快捷方式、State 和 Logs，
  `Data` 哈希不变；同一 `.exe` 重装后数据恢复、版本与 doctor 正常；
- 非交互 purge 缺少 `--delete-all-cinba-data` 时拒绝；交互 purge 输入非确认短语时不删除任何内容；
- 探针结束后程序、数据、注册、快捷方式、计划任务全部清除，用户 PATH 与基线逐字一致。

发现的问题：

1. **Desktop 运行时卸载会挂起并与重装竞争。** `cinba uninstall` 不关闭 Desktop；helper 在
   Desktop 退出前一直不结束（复现 2 分钟以上），期间 `desktop\` 与数据都未删除，Desktop 退出后
   才完成。若此时重跑安装器，安装进程无界面消失，留下 `phase: "staging"` 的事务；此后每次安装
   都只弹出 “Cinba installation failed with exit code 1”，内部错误为
   `installation transaction … is still staging`，重跑安装器无法修复。
2. **Core 被 On-demand 实例占用时切换 Background 误报成功。** Desktop 持有 4517 时执行
   `cinba core mode background` 输出 `Service: running / Health: healthy`，但计划任务以退出码 1
   结束，健康检查命中的是原 On-demand Core；之后 `cinba core mode` 显示 `Service: stopped`。
   规格要求的交接没有发生。
3. **Cinba Dev 与正式版未完全隔离。** Dev Core 使用 `127.0.0.1:4518`，正式 Sync 服务也使用
   4518；`cinba-dev doctor` 调用 `inspectLocalCore()` 时未传 Dev 配置，回落到旧默认
   `4517` / `~/.cinba`，实际报告了正式 Core 的 revision。
4. 正式 launcher 追加在用户 PATH 末尾；本机旧 `npm link` 残留的全局 `cinba` 优先解析，新 shell
   中的 `cinba` 不是正式版。干净账号不受影响，但开发机需要提示或文档说明。
5. 次要：`doctor` 未显示解析后的数据路径；Background 服务在 `core status` 中显示为
   `Lifecycle: external`；purge 后残留空的 `%LOCALAPPDATA%\Cinba`；`update.json` 在仅有 Draft
   时记录 `discovery-failed`。
6. 已确认不是产品缺陷：purge 后 `Data` “回到旧状态”是测试环境造成的。探针命令运行在 Claude
   桌面应用的 MSIX 容器内，新建的 `%LOCALAPPDATA%\Cinba` 被重定向到
   `%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Local\Cinba`；由 Task Scheduler 在容器外启动的
   Background Core 则写入真实路径。容器内 purge 删除重定向副本后，真实路径中 Background 写入的
   旧数据透出。已有的 `%LOCALAPPDATA%\Programs` 不受重定向。以后在此类环境探针时，涉及 Data
   的结论需从容器外（例如一次性计划任务）核对真实路径。

问题 1—3 已分别由 `a74a5ab`（卸载先关闭 Desktop，helper 持有安装锁，安装器等待并回收失效事务、
失败弹窗显示真实错误）、`149bfc5`（Background 先交接空闲 On-demand Core，健康检查核对服务 PID
与控制 token）和 `2e4ae1e`（Cinba Dev 改用 4527/4528，`cinba-dev doctor` 检查 Dev Core）修复，
`npm run check` 通过。

### 修复后复测

2026-09-19 从 `666533154632ec55008609da0f9695d7d422c1ca` 重建 Draft
（[Prepare product release](https://github.com/SounDoer/Cinba/actions/runs/35426240854)），六个资产
齐全，manifest 大小和 SHA-256 与 GitHub asset digest 一致，Windows 安装包 attestation 校验通过。
在同一当前用户上用新 `.exe` 复测：

- Desktop 持有 On-demand Core 时 `cinba core mode background` 完成交接：4517 改由服务的
  `node.exe` 持有，计划任务保持 Running，Desktop 重新连接；关闭 Desktop 后服务继续运行，切回
  On-demand 后任务删除、Core 停止；
- Desktop 运行时普通卸载先输出 “Cinba Desktop was closed.”，helper 约 30 秒完成；卸载期间
  立即启动的安装器提示等待卸载结束，随后正常完成安装；除 Desktop 重新启动写入的
  `lastSessionId` 外数据哈希不变；
- Desktop 运行时非交互 purge 先关闭 Desktop，约 9 秒完成；
- 正式 Core 使用 4517、Cinba Dev Core 使用 4527，`cinba-dev doctor` 报告 Dev 自身的 managed
  Core，Dev 不注册计划任务。

复测新发现：

- Desktop 与 TUI 均没有规格 §19 要求的“卸载 Cinba”和“卸载并删除所有数据”入口，只能通过
  Windows“已安装的应用”或 Shell CLI 卸载；
- Windows helper 的延迟清理未生效，每次卸载在 `%TEMP%\cinba-uninstall-*` 残留约 94 MB 的
  `cinba-helper.exe`。

### 卸载入口复测

2026-09-19 从 `338a730ada099bbef450495e0b5d4b7c5e73428f` 重建 Draft
（[Prepare product release](https://github.com/SounDoer/Cinba/actions/runs/35429369928)），资产、
manifest、`SHA256SUMS` 与 Windows attestation 校验一致。复测结果：

- Desktop 托盘出现 Uninstall 子菜单（“Uninstall Cinba…” / “Uninstall and Delete All Data…”）；
  普通卸载对话框说明保留的数据，键盘焦点默认在 Cancel；
- helper 临时目录清理修复生效：CLI 卸载、purge 和失败的界面卸载之后均无
  `%TEMP%\cinba-uninstall-*` 残留；
- **阻断发布：从 Desktop 发起的卸载不删除任何内容。** 确认后 Desktop 退出，helper 数秒内结束，
  程序与注册保持原样且无任何提示。原因是 launcher 以 helper PID 持有安装锁，界面发起时 helper
  在等待界面退出后再次调用 `stopProductForUninstall()`，其中 `setProductComponentMode` 申请
  同一把安装锁，锁持有者（helper 自身）存活，于是抛出 “another Cinba installation transaction is
  active”。用占位进程模拟界面可稳定复现；未预持锁时手动运行 helper 则成功。TUI `/uninstall` 与
  Desktop purge 走同一路径，未单独实测。已由 `26bc5cb` 修复，待重建 Draft 后复测。

未覆盖：干净账号、SmartScreen、TUI 交互、On-demand 空闲停止、注销或重启后 Background 恢复、
离线安装，以及 Cinba Dev 与正式 Sync 同时运行的实测。下方 Windows 验收项仍保持未勾选。

## 正式发版前置检查

- [x] 当前提交已推送到公开仓库的 `master`；
- [x] 仓库 Settings 中已启用 Immutable Releases；
- [x] Actions 允许 workflow 使用 `contents: write`、`id-token: write` 和 `attestations: write`；
- [x] 手工触发 **Prepare product release**，输入 `0.1.0`、完整 master SHA 和中英变更摘要；
- [x] Windows、macOS、Linux 原生 runner 均从同一 SHA 通过 `npm run check`；
- [x] draft 同时包含 `.exe`、`.dmg`、`.tar.gz`、`install.sh`、`cinba-release.json` 和 `SHA256SUMS`；
- [x] artifact 名、manifest revision、版本、大小和 SHA-256 一致；
- [x] GitHub artifact attestations 可查询；
- [x] Release notes 包含准确的中英双语三平台安装说明、SmartScreen/Gatekeeper 说明和 `xattr`
      命令；
- [ ] 人工复核完整集合后才发布 draft；
- [ ] 发布后 GitHub 将 Release 标记为 Immutable，updater 能发现它且忽略 draft/prerelease。

## Windows 10/11 x64

- [ ] 无 Node、npm、Git 和全局 Pi 的普通用户可运行 `.exe` 完成安装；
- [ ] 不触发管理员权限，不创建桌面快捷方式，Start Menu 和 Apps 注册正确；
- [ ] 新 shell 中 `cinba version`、`cinba doctor`、默认 TUI 和 Desktop 可用；
- [ ] On-demand Core、Background Core、关 Desktop 后的生命周期符合规格；
- [ ] 普通卸载保留数据，重装可继续使用；purge 二次确认后才删除正式数据；
- [ ] Cinba Dev 可与 Cinba 同时运行且状态完全隔离。

## macOS 13.5+ Apple Silicon

- [ ] 无 Node、npm、Git 和全局 Pi 的普通用户可从 DMG 安装到 `~/Applications/Cinba.app`；
- [ ] 未签名提示与 release notes 一致，必要时给出的 `xattr` 命令有效；
- [ ] 新 shell 中 `cinba` 可用，Desktop/Menu Bar 与 On-demand/Background Core 符合规格；
- [ ] 普通卸载、保留数据重装与 purge 边界正确；
- [ ] Cinba Dev 与正式 Cinba 完全隔离。

## Ubuntu 22.04/24.04 x64 与干净 VPS

- [ ] 同一条 release notes bootstrap 在普通机器和清空后的 VPS 上完成安装；
- [ ] 安装结束不自动启动 TUI、Core、Sync 或 Background；
- [ ] 手工复制 archive 的离线安装不访问 npm、Node 官网或 pi.dev；
- [ ] `cinba` 默认 TUI、诊断与更新命令可用；
- [ ] Background Core/Sync 以普通用户运行，SSH 断开后继续，重启后按模式恢复；
- [ ] 无 linger 时给出可理解的诊断和修复边界；
- [ ] 不安装或配置 Tailscale、Caddy、TLS、域名和防火墙。

## 更新、兼容与恢复

- [ ] `0.1.0` 安装后能发现下一正式 immutable release，不能发现 draft/prerelease；
- [ ] 下载可续传并校验，损坏 candidate 不会激活；
- [ ] 未确认时不安装，活跃任务不会被强制终止；
- [ ] Desktop 与 TUI handoff 后返回原表面，恢复原 Core/Sync 生命周期模式；
- [ ] 候选启动、健康检查或数据迁移失败时恢复旧程序与快照；
- [ ] N-1 客户端连接 N Core、N 客户端连接 N-1 Core 的兼容矩阵符合 protocol/capabilities；
- [ ] protocol 不兼容时明确失败，不表现为随机断线或部分功能损坏。

## 收尾

- [ ] 第一轮真实验收的问题已回写自动化测试或规格；
- [ ] 清空后的旧 VPS 已使用正式 Headless artifact 重建；
- [ ] 远端 `prod` 分支已在新发布链验收后删除；
- [ ] 不再存在第二套 Git checkout/VPS deployment 产品路径。
