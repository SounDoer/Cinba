# Cinba 产品分发验收记录

日期：2026-09-18

最后更新：2026-09-21

状态：`v0.1.1` 已从 `a54322a` 正式发布并标记 Immutable；三平台原生构建、公开 bootstrap、updater
发现和真实 VPS 安装均已验证；旧 `packages/deploy` 与远端 `prod` 分支已退役；macOS 安装包仍缺少
真实用户安装验收

对应规格：`docs/specs/2026-09-17-cinba-product-distribution-design.md`

对应计划：`docs/plans/2026-09-17-cinba-product-distribution.md`

## 已由自动化验证

- 根 `package.json` 是唯一产品版本源；首个正式版本为 `0.1.0`，当前发布准备版本为 `0.1.1`；
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

从 `44e0eaec9258d6ed533b298b658cd77f081f5710` 重建 Draft
（[Prepare product release](https://github.com/SounDoer/Cinba/actions/runs/35431722516)）后复测，
安装锁自冲突已消除，但界面发起的卸载仍未完成，继续阻断发布：

- TUI（在常驻 `cmd.exe` 中运行）`/uninstall`：选择列表默认保留数据、确认默认 Cancel；确认后
  `__begin-uninstall` 停止 Core，TUI 随即报告无法连接 Core 并以退出码 1 退出，仍在复制 helper
  的 launcher 被一并终止，`cinba-helper.exe` 为 0 字节，未删除任何内容；
- Desktop 托盘普通卸载：Desktop 退出，helper 移除注册、开始菜单、PATH、`bin`、`releases` 和
  State，数据哈希不变；但删除 `desktop\` 时因 Desktop 退出后的短暂文件占用失败，
  `uninstall-helper.log` 记录 “could not remove: program”，留下 75 个文件的半卸载状态；helper
  从启动到删除耗时约 68 秒；
- 失败日志按设计写入 `Logs/uninstall-helper.log`；各次卸载后 `%TEMP%` 均无 helper 残留。

已由 `27f83c5`（交接期间 TUI 忽略 Core 断开、launcher 改为 detached）、`cc7b5bf`（helper 不再继承
Desktop 程序目录作为工作目录，停止 Desktop 目录下全部进程，程序目录退避重试并在失败时改名交给
cmd.exe 延迟删除）和 `4db4f92`（去掉 PATH 变更后多余的 WM_SETTINGCHANGE 广播）修复。

从 `f4025b4ffb773cc7500aeebd40d94401251ac3a0` 重建 Draft
（[Prepare product release](https://github.com/SounDoer/Cinba/actions/runs/35436879885)），资产、
manifest、`SHA256SUMS` 与 Windows attestation 校验一致。在同一当前用户上复测三个界面卸载入口，
全部通过：

- TUI（常驻 `cmd.exe` 中运行）`/uninstall` 普通卸载：选择默认保留数据、确认默认 Cancel；确认后
  TUI 干净退回 shell 提示符，helper 约 13 秒完成；程序、注册、开始菜单、计划任务和 PATH 移除，
  仅保留 `Data`；
- 重装后保留数据恢复（标记文件仍在，仅 `lastSessionId` 随新会话变化）；
- Desktop 托盘 “Uninstall Cinba…”：对话框默认 Cancel；Desktop 退出后 helper 约 8 秒完成，
  `Data` 哈希不变；
- Desktop 托盘 “Uninstall and Delete All Data…”：两个对话框均默认 Cancel，第二个对话框的确认
  勾选框默认未勾选；勾选并确认后约 8 秒完成，程序与全部数据删除；
- 三次卸载均无 `uninstall-helper.log`，`%TEMP%` 无 helper 残留；容器外真实路径亦无残留；
- 仍存在的小问题：purge 后留下空的 `%LOCALAPPDATA%\Cinba`（本次仅见于 MSIX 重定向视图）。

未实测：不勾选确认框直接点击删除按钮的拒绝路径（由单元测试覆盖）、TUI purge 的键入确认。

未覆盖：干净账号、SmartScreen、TUI 交互、On-demand 空闲停止、注销或重启后 Background 恢复、
离线安装，以及 Cinba Dev 与正式 Sync 同时运行的实测。下方 Windows 验收项仍保持未勾选。

### Windows 补充探针

同一 `f4025b4` Draft、同一当前用户：

- 安装过程中安装器与 Cinba 进程没有任何外部 TCP 连接；Desktop 首次启动 60 秒内仅有一次到 GitHub
  （`20.205.243.168:443`）的连接，对应自动更新检查，因仅有 Draft 而记录 `discovery-failed`；
- 给安装包加上 Internet 区域的 Zone.Identifier 后通过资源管理器启动，SmartScreen 弹出拦截
  提示，经“更多信息”→“仍要运行”放行后安装继续，与 release notes 说明一致；
- 无客户端的 On-demand Core 在 10.1 分钟后自动停止（“no clients remain; stopping the idle
  on-demand Core”）；
- TUI purge：确认默认 Cancel；键入错误短语时提示 “Cinba purge cancelled; nothing was removed.”
  且不删除任何内容；键入 `DELETE ALL CINBA DATA` 后约 14 秒删除程序与全部数据，仍留下空的
  `%LOCALAPPDATA%\Cinba`；
- 为干净账号编写的分阶段验收脚本在本机试运行：`installed` 阶段正确识别旧 `npm link` 抢占 PATH，
  `background` 阶段各项通过。

## Linux 容器探针

2026-09-19 在本机 Docker 中用 `f4025b4` Draft 的 `Cinba-0.1.0-linux-x64-gnu.tar.gz`（`SHA256SUMS`
校验通过）测试。所有容器均以 `--network none` 运行，无 Node、npm、Git、Pi 和 curl；普通用户
`tester` 以 bash 登录 shell 执行包内 `install.sh`。容器不能代表真实 VPS 的 SSH、内核与重启，
bootstrap 一行命令需正式发布后才能从公开 URL 测试。

普通 Ubuntu 22.04 / 24.04 容器（无 systemd）：

- root 执行 `install.sh` 被拒绝；普通用户离线安装成功，未访问网络；
- 安装结束未启动任何 Cinba 进程；除用户 home 外没有写入任何文件；不涉及 Tailscale、Caddy；
- `.bashrc` 写入 `# >>> Cinba CLI >>>` 标记块，新 login shell 解析 `~/.local/bin/cinba`；`version`、
  `help`、默认 TUI 正常，On-demand Core 可启动和停止；
- **缺陷：没有 `systemctl` 时 `doctor` 的 Core 检查、`core mode` 查询与切换、普通卸载和 purge
  全部以 `spawn systemctl ENOENT` 失败，产品无法卸载**（数据未受影响）；
- 非交互 purge 缺少 `--delete-all-cinba-data` 时拒绝；离线 `cinba update` 只输出 `fetch failed`。

带 systemd 的 Ubuntu 24.04 特权容器（systemd 为 PID 1，断网）：

- 离线安装后 `doctor` 全部通过，默认 On-demand；
- 未启用 linger 时切换 Background 失败且未误报成功，但诊断只有 “could not set Cinba Core to
  background / registration-failed”，没有说明 linger 与修复方法；
- 管理员 `loginctl enable-linger` 后切换 Background 成功，`cinba-core.service` 以 user unit 运行，
  登录会话结束后继续运行；重启容器后按 Background 自动恢复；切回 On-demand 删除 unit；
- 普通卸载移除 launcher、`lib`、`state`、`.bashrc` 标记块和 user unit，数据哈希不变，linger
  保持不变；重装恢复数据；purge 删除全部内容，但留下空的 `~/.local/share/cinba`（Windows 上同样
  留下空的 `%LOCALAPPDATA%\Cinba`）。

### Linux 修复后复测

`9625bcc`（无 systemd / 无 linger 处理）、`be1680e`（purge 删除空数据根目录）和 `c696983`（更新网络
错误说明）合入后，从 `c696983cd0e66e0898ab14a61220787382898331` 重建 Draft
（[Prepare product release](https://github.com/SounDoer/Cinba/actions/runs/35442241729)），资产、
manifest、`SHA256SUMS` 与 Windows、Linux attestation 校验一致。同样的容器复测全部通过：

- 无 systemd（22.04 / 24.04）：`doctor` 以 INFO 报告 “Background unavailable: this host does not
  run systemd”，结论 ready；`core mode` 显示不可用原因；切换 Background 被拒绝并说明原因，保持
  On-demand；普通卸载成功且数据不变；purge 成功且不留 `~/.local/share/cinba`；离线
  `cinba update` 报告 “could not reach GitHub Releases … (getaddrinfo EAI_AGAIN api.github.com)”；
- systemd 无 linger：非交互时说明需要 linger 并给出 `sudo loginctl enable-linger tester`，保持
  On-demand、无 unit；交互终端询问 “Enable linger? [y/N]”，拒绝后同样保持 On-demand；
- systemd + linger：Background、登出后继续运行、重启恢复、切回 On-demand、卸载保留数据与
  linger、重装恢复、purge 全部删除，均与之前一致；
- Windows：purge 后不再留下 `%LOCALAPPDATA%\Cinba`；仅有 Draft 时 `cinba update` 报告
  “GitHub latest release request failed with HTTP 404”，正式发布后不再出现。

### 候选 Draft

`cbdc4d8` 补充 Release notes（macOS 在 DMG 中被 Gatekeeper 阻止时先复制到 `~/Applications`、
Linux 重新加载 shell 与 Background 的 systemd / linger 要求、各平台卸载入口与 purge、Windows 版本
写法），`e8a6ca1` 加入 `scripts/acceptance/` 验收脚本。二者都不进入产品 payload，因此
`c696983` 上的 Windows 与 Linux 实测结论仍然适用。

从 `e8a6ca1771c72d04dc036ea5c8f9ba021e68fdc5` 重建 Draft
（[Prepare product release](https://github.com/SounDoer/Cinba/actions/runs/35444030619)）：六个资产
与 `SHA256SUMS`、GitHub asset digest 一致；manifest revision 为 `e8a6ca1`；六个资产的 attestation
均可验证；`install.sh` 内嵌的 archive 哈希与 Linux archive 一致；Draft 正文与本地
`scripts/release-notes.ts` 渲染结果逐字一致。macOS DMG 的 SHA-256 为
`888b5a25e0ed613dbd762b8cbf4334053c4e216d82989a8a30367823062b747c`。

### 安装体验复测

Windows 安装在进度提示上停留很久：`1db7d2f` 改写安装器提示并用 `nsExec::ExecToLog` 流式显示
launcher 的阶段输出，`af1f453` 让 Windows 安装器以 `--consume-bundle` 移动 payload 而不是复制，
并为激活阶段的 rename 加入约五秒退避重试。从
`af1f4538ec6424c79ec940b3d75017745c85b05f` 重建 Draft
（[Prepare product release](https://github.com/SounDoer/Cinba/actions/runs/35486268634)）后实测：

- 修改前后对比：安装 146 秒 → 63—65 秒；同一构建不带 `--consume-bundle` 的复制路径为 210 秒，
  说明差异来自 payload 移动；
- 安装器详情区的默认提示为 “Installing Cinba. This usually takes a few minutes.”，不再声称在等待
  卸载；直接运行 launcher 可见阶段输出实时产生：checking-package 1.1s、preparing 与
  copying-payload 96.2s、activating 与 verifying 203.4s（复制路径计时）；
- 回归：普通卸载 14 秒且数据哈希不变，重装 59 秒且标记文件恢复，purge 后无残留，`%TEMP%` 无
  helper 残留；
- Linux 容器复测通过，并用同一解压目录成功重装，确认 `install.sh` 路径仍为复制、包目录保留；
- 修改前后 `%TEMP%` 都会留下 `ns*.tmp` 目录，修改后该目录为空。后续对照实验表明，勾选与不勾选
  “Launch Cinba” 都会残留，与 Desktop 启动无关；安装器退出后可手工删除，说明是退出时删除失败。
  当时的旧安装包已删除，无法与改动前做对照，故不能断定该残留由本轮改动引入。

过程中两次异常均由探针自身造成，非产品缺陷：一次复制到的是上一轮 Draft 残留的 bundle（改用
7-Zip 从安装包解出后确认新代码已包含）；一次监控脚本持续递归枚举 `releases` 导致激活 rename
报 `EPERM`，事务如实回滚，这正是本轮重试所针对的场景。

### 安装器临时目录复测

`304db9c` 定位到根因：脚本中的 `SetOutPath "$PLUGINSDIR\CinbaBundle"` 使解压目录成为安装器的当前
工作目录，Windows 不允许删除任何进程正在使用的工作目录，因此安装器退出时删除 `$PLUGINSDIR`
只删掉文件、留下两层空目录；与 `cc7b5bf` 的卸载 helper 是同一机制。修复为执行安装后、失败分支
之前切回 `$TEMP`。

从 `304db9c5d711902677be01352a42a8fb85dc1b48` 重建 Draft
（[Prepare product release](https://github.com/SounDoer/Cinba/actions/runs/35495656822)），资产与
attestation 校验一致。复测结果：

- 勾选 “Launch Cinba” 安装 61 秒、清除勾选安装 67 秒，两次之后 `%TEMP%` 均无 `ns*.tmp` 残留；
  清除勾选时 Desktop 确实未启动；
- 回归：普通卸载 14 秒且数据哈希不变，重装 67 秒且标记文件恢复，purge 后程序、数据与 PATH 条目
  均清除，全程无 helper 与临时目录残留；
- Linux 容器复测通过（安装、doctor、无 systemd 说明、离线更新提示、卸载保留数据、重装、purge）。

两条看似异常的观察均非缺陷：清除启动勾选的安装后数据目录尚未创建，符合“配置在首次进入产品后
完成”的规格；PATH 基线记录时机器上已装有 Cinba，purge 后差异仅为该条目本身。

## 正式发布 v0.1.0

2026-09-20 将 `827153f1391406350bc0c2c89f98132a9fe68b7e` 的 Draft 正式发布为
[v0.1.0](https://github.com/SounDoer/Cinba/releases/tag/v0.1.0)。发布前 release notes 已按“只服务于
安装”精简（`827153f`）。发布时 macOS 仍未在 `8eec5f1` 之后的任何构建上实测，这一风险由发布决定
承担：若 macOS 出现问题，按 `0.1.1` 补发。

发布后立即验证：

- Release 非 draft、非 prerelease，`isImmutable=true`，六个资产齐全；不可变 tag `v0.1.0` 指向
  `827153f`；`releases/latest` 返回 `v0.1.0`；
- 尝试替换已发布资产被拒绝（“Cannot delete asset from an immutable release”），未造成改动；
- **release notes 的一行 bootstrap 在联网的干净 Ubuntu 24.04 容器上成功**：无 Node、npm、Git、Pi，
  `curl -fsSL …/install.sh | sh` 下载 122 MB、校验通过并安装，显示 checking-package 到 verifying
  的阶段进度；安装结束未启动任何进程；新 login shell 中 `cinba version` 与 `doctor` 通过；
- **updater 能发现已发布版本**：容器中 `cinba update` 输出 “Cinba 0.1.0 is current.”；
- Linux 普通卸载正常；Windows 安装正式包后 `version` 正确且无 `ns*.tmp` 残留。

Windows 上的 `cinba update` 返回 `GitHub latest release request failed with HTTP 403`，经查为本机
匿名 API 限流（`x-ratelimit-remaining: 0`，限额 60/小时，约 25 分钟后重置），同时刻容器中成功，
非产品缺陷；提示未说明限流与重试时间，已记入待改进。

## 正式发布 v0.1.1

2026-09-21 将 `a54322a6a3f6697e563162e13b4388b0c5228a9d` 通过
[Prepare product release](https://github.com/SounDoer/Cinba/actions/runs/35583350967) 构建并正式发布为
[v0.1.1](https://github.com/SounDoer/Cinba/releases/tag/v0.1.1)。Windows、macOS、Linux 原生 runner
分别通过完整 `npm run check`，三个 artifact、bootstrap、manifest 与 SHA256SUMS 完成 attestation；
release 非 draft、非 prerelease，`isImmutable=true`，tag 与 latest 均指向锁定 revision。

发布后验证：

- GitHub asset digest、SHA256SUMS 与 manifest 中的大小和 SHA-256 全部一致；
- 公开的一行 bootstrap 在全新 Ubuntu 24.04 容器中下载 122 MB、校验并安装成功，`version`、`doctor`
  与 `sync status --json` 正确；
- 真实 VPS 从候选 `0.1.0 (99a5742f)` 通过正式 `v0.1.1` bootstrap 更新，原 Sync authority、管理员
  设置、background mode 与 Core enrollment 保持；两个 HTTPS 入口继续返回 200；
- VPS 建立权限 `600` 的一致性备份并记录 SHA-256；备份仍与 VPS 同盘，只用于误操作恢复，异机加密
  副本需在个人设备上完成。
- 新部署完成 TUI、手机登录和两次真实重启验收后，旧 `cinba` 用户的每分钟 update timer、源码服务、
  checkout、私有 Node、隔离数据、SSH key、home、系统用户与同名组均已永久删除；Caddy、Tailscale 和
  `xichen` 正式部署不受影响。

验收发现 `v0.1.1` 的独立 `cinba update` 错把命令行 handoff 标记为 TUI，并让 detached helper 继承
SSH PTY；SSH 关闭后安装没有提交，安全地保留旧版本，却重启了无 TTY 的 TUI。正式 bootstrap 可完成
更新。`9339963` 已在发布后按 TDD 修复：增加 `cli` handoff、禁止 surface restart，并让 helper 脱离
终端 stdio；该修复不属于 immutable `v0.1.1`，将在下一版本发布。

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
- [x] 人工复核完整集合后才发布 draft；
- [x] 发布后 GitHub 将 Release 标记为 Immutable，updater 能发现它且忽略 draft/prerelease。

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

- [x] 正式 Headless artifact 在干净容器和清理旧服务后的 VPS 上完成安装；
- [x] 安装结束不自动启动 TUI、Core、Sync 或 Background；
- [x] 手工复制 archive 的离线安装不访问 npm、Node 官网或 pi.dev；
- [x] `cinba` 版本、帮助、诊断和 Sync 状态命令可用；
- [x] Background Core/Sync 以普通用户运行，SSH 断开后继续，重启后按模式恢复；
- [x] 无 linger 时给出可理解的诊断和修复边界；
- [x] 不安装或配置 Tailscale、Caddy、TLS、域名和防火墙。

真实 VPS 先以 revision `99a5742f3fe2767c74d4032fb989c320b774edb9` candidate 完成安装，再通过
正式 bootstrap 更新到 `v0.1.1 (a54322a6a3f6697e563162e13b4388b0c5228a9d)`。Cinba 安装在 `xichen`
账户，Core/Sync 只监听 loopback，Sync 完成首次设置并连接一个 Core。第一次重启暴露用户自有 Caddy
早于 Tailscale 地址就绪的竞态；为 Caddy unit 增加 Tailscale 顺序依赖和失败重试后，第二次重启中
Caddy、Tailscale、Core、Sync 与两个 HTTPS 入口全部自动恢复。旧源码部署、timer、隔离目录和专用
系统账户均在用户确认后永久删除，上传和解压临时目录也已删除。

## 更新、兼容与恢复

- [x] `0.1.0` 安装后能发现 `v0.1.1` 正式 immutable release，draft 阶段与发布后 latest 行为正确；
- [ ] 下载可续传并校验，损坏 candidate 不会激活；
- [ ] 未确认时不安装，活跃任务不会被强制终止；
- [ ] Desktop 与 TUI handoff 后返回原表面，恢复原 Core/Sync 生命周期模式；
- [ ] 候选启动、健康检查或数据迁移失败时恢复旧程序与快照；
- [ ] N-1 客户端连接 N Core、N 客户端连接 N-1 Core 的兼容矩阵符合 protocol/capabilities；
- [ ] protocol 不兼容时明确失败，不表现为随机断线或部分功能损坏。

## 收尾

- [x] 第一轮真实验收的问题已回写自动化测试或规格；
- [x] 清理旧服务后的 VPS 已使用正式 Headless artifact 重建；
- [x] 远端 `prod` 分支已在新发布链验收后删除；
- [x] 不再存在运行中的第二套 Git checkout/VPS deployment 产品路径。
- [x] 旧 VPS update timer、隔离部署数据和专用系统账户已在最终确认后永久删除。
