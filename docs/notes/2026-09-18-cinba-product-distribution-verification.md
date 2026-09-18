# Cinba 产品分发验收记录

日期：2026-09-18

状态：仓库内实现完成；正式 Release 与真实平台验收待执行

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
- 本轮最终 `npm run check` 通过：952 个单元测试（2 个平台限定跳过）、11 个端到端测试和 Web、
  Desktop、Sync Web 构建全部成功。

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

## 正式发版前置检查

- [ ] 当前提交已推送到公开仓库的 `master`；
- [ ] 仓库 Settings 中已启用 Immutable Releases；
- [ ] Actions 允许 workflow 使用 `contents: write`、`id-token: write` 和 `attestations: write`；
- [ ] 手工触发 **Prepare product release**，输入 `0.1.0`、完整 master SHA 和中英变更摘要；
- [ ] Windows、macOS、Linux 原生 runner 均从同一 SHA 通过 `npm run check`；
- [ ] draft 同时包含 `.exe`、`.dmg`、`.tar.gz`、`install.sh`、`cinba-release.json` 和 `SHA256SUMS`；
- [ ] artifact 名、manifest revision、版本、大小和 SHA-256 一致；
- [ ] GitHub artifact attestations 可查询；
- [ ] Release notes 包含准确的中英双语三平台安装说明、SmartScreen/Gatekeeper 说明和 `xattr`
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
