# VPS 首轮环境盘点

日期：2026-09-13

状态：真实 VPS bootstrap、Tailscale 私网接入与 Caddy HTTPS 验收已完成

## 1. 检查边界

本轮通过已有 SSH key 以普通部署用户登录 VPS，只执行无提权的只读命令。没有使用
`sudo`，没有读取凭据、私钥或其他敏感内容，也没有修改服务、配置、防火墙或文件。

仓库已经公开，因此本文不记录真实公网 IP、SSH 用户名、既有站点域名或未来的真实
MagicDNS 名称。连接信息继续留在仓库之外。

## 2. 操作系统与基础工具

- 系统为 Ubuntu 24.04.4 LTS（Noble Numbat）。
- 架构为 `amd64` / `x86_64`。
- systemd 版本为 255。
- Node.js 位于 `/usr/bin/node`，版本为 22.23.1，不满足 Cinba 的 Node.js 24+ 要求。
- npm 位于 `/usr/bin/npm`，版本为 10.9.8。
- Git 位于 `/usr/bin/git`，版本为 2.43.0。
- `flock` 位于 `/usr/bin/flock`，来自 util-linux 2.39.3。
- `/home` 所在根文件系统约 69 GB，已使用约 11 GB，剩余约 56 GB。

## 3. Tailscale

首轮检查时 VPS 尚未安装 Tailscale。后续已完成以下实际配置：

- 安装 Tailscale 1.102.4，并以不含个人信息的机器名加入独立 tailnet；
- 节点使用生产服务 tag，Tailscale SSH 保持关闭；
- MagicDNS 与 Tailscale HTTPS Certificates 已启用；
- 删除 tailnet 初始的全开放规则和默认 Tailscale SSH 规则；
- Grant 只允许指定 owner 身份访问生产服务 tag 的 `tcp:443`；
- iPhone 作为第一个受信客户端加入同一 tailnet；
- `tailscaled` 仅授权 `caddy` 用户请求 Tailscale 证书，没有向 Cinba 用户授予额外系统权限。

真实 Tailscale IP、完整 MagicDNS 名称、登录身份和一次性认证链接不进入公开仓库。HTTPS 证书会让
机器域名出现在公开证书透明度日志中，这一点已在启用前确认接受。

## 4. Caddy 与既有应用

- 首轮检查时 Caddy 版本为 Ubuntu 提供的 2.6.2；实操中升级为 Caddy 官方 stable 仓库的 2.11.4。
- `caddy.service` 正在运行并已启用开机启动。
- unit 来自系统级路径 `/usr/lib/systemd/system/caddy.service`。
- 主配置为 root 所有、普通用户可读的 `/etc/caddy/Caddyfile`。
- 当前配置包含三个既有站点：两个反向代理到 loopback 后端，一个提供静态文件。
- 两个既有后端分别监听 `127.0.0.1:3000` 和 `127.0.0.1:8080`。
- Caddy 管理接口监听 `127.0.0.1:2019`。
- Caddy 当前在所有网卡监听 `80/tcp`、`443/tcp`，并监听 `443/udp`。

最终配置完整保留三个既有站点，并新增只绑定 Tailscale IPv4 的 Cinba HTTPS 站点，反向代理到
`127.0.0.1:4517`。公网 listener 保持原样；Cinba 的 listener 只启用 HTTP/1.1 与 HTTP/2，公网
listener 继续使用 HTTP/3。

实操发现，仅给新站点增加 `bind` 会让新旧 listener 同时尝试占用 `443/udp`，导致 reload 失败。
最终使用 Caddy 的 listener-specific `servers` 配置关闭 Tailscale listener 的 HTTP/3，避开
wildcard UDP listener 冲突。候选配置先以 `caddy validate` 验证，再安装和 reload；原配置另有
root 所有的现场备份。升级和最终 reload 后，三个既有站点均通过回归检查。

## 5. 防火墙与端口

- UFW 已安装，但实际运行状态为 inactive。首轮仅根据 systemd unit 状态写下的 active 判断不准确，
  后续管理员只读检查已经纠正。
- IPv4 INPUT 默认策略为 ACCEPT；Tailscale 自己的链允许 `tailscale0` 和直连 UDP 端口，并拒绝从
  非 Tailscale 网卡伪造的 CGNAT 源地址。
- 云厂商注入的链是恶意来源地址拒绝列表，不是端口 allowlist。
- 当前对外监听包括 `22/tcp`、`80/tcp`、`443/tcp` 和 `443/udp`。
- `3000/tcp`、`8080/tcp` 和 `2019/tcp` 只监听 loopback。
- Cinba 的 `4517/tcp` 只监听 `127.0.0.1`。
- 云防火墙允许既有公网 Web、SSH 与 ICMP 流量，没有为 Cinba 新增公网端口；Tailscale 可在不能
  直连时使用 DERP relay。

断开手机 Tailscale 后，同一 Cinba URL 无法访问；重新连接后恢复。这项实测确认 Cinba 没有因
现有公网 `80/443` listener 而意外公开。

## 6. systemd user service 条件

- systemd user manager 可以正常运行。
- 首轮检查时当前 SSH 用户的 user manager 仅在登录期间运行，`cinba` 用户尚不存在。
- 现已创建无 sudo、无密码登录能力的独立 `cinba` 普通用户，并启用 linger。
- `cinba.service`、`cinba-update.service` 与 `cinba-update.timer` 均以 systemd user unit 安装。

采用 systemd user service 的设计已在退出管理 SSH 后验证：Core 持续运行，timer 能独立完成
无更新检查，日常部署不需要 sudo、webhook 或人工 SSH。

## 7. 用户与 `/home` 布局

- 首轮检查时系统有四个带真实 home 和交互 shell 的普通用户。
- 其中两个既有用户属于 `sudo` 组；当前用于盘点的部署用户不属于 `sudo` 组。
- `/home` 下已有四个互相独立、权限为 `0750` 的用户目录。
- `/home/cinba` 后续由管理员创建，Cinba 的程序、release、运行数据与 SSH 管理入口均与既有用户
  隔离。

首次 bootstrap 最终通过已有管理员入口逐项完成；Cinba 没有使用管理员账号或 root 运行。

## 8. 管理操作边界

本次实操先以普通用户完成只读盘点；需要创建用户、安装系统包、修改 `/etc` 或 reload 系统服务时，
均先说明影响，再由管理员明确执行。没有读取或打印密码、私钥、API key 等敏感内容。

SSH 仅用于首次安装、验收和故障处理。正常发布由 VPS timer 主动拉取 `prod`，Tailscale SSH 保持
关闭，Cinba 用户也没有 sudo 权限。

## 9. 首次 bootstrap 进展

首轮盘点后，同日完成了以下实际配置：

- 创建独立普通用户 `cinba`，home 为 `/home/cinba`，没有 sudo 权限，也没有可用于密码登录的密码；
- 为 `cinba` 启用 systemd linger；
- 从 Node.js 官方发布包安装并校验 Node.js 24.21.0，运行时独立位于 `cinba` home 下，不替换
  系统已有的 Node.js 22；
- 为首次安装与故障处理配置独立 SSH key；日常部署仍不依赖 SSH；
- 将公开仓库 clone 到 `/home/cinba/Cinba`；
- 加入并安装 `cinba.service`、`cinba-update.service` 与 `cinba-update.timer`；unit 已通过 VPS 上的
  `systemd-analyze --user verify`；
- 在真实 Linux 与 Node.js 24 环境中运行完整 `npm run check`，261 个单元测试、5 个 E2E 和 Web
  build 全部通过；
- 首次创建 `prod`，并通过一次受控的手工 bootstrap 部署生成首个 release 与 `current`；
- 首个 Core 已由 systemd user service 运行并启用开机启动；
- Core 已确认只监听 `127.0.0.1:4517`，健康接口返回准确的 40 位运行 revision；
- update timer 已启用，并连续完成两次无更新检查；Core PID、`current` 和健康 revision 均未变化。

首次没有 `/home/cinba/current` 时，由长期 checkout 中的部署器完成第一次 release 准备与切换；
成功以后，update service 从 `current` 中运行。这个接棒流程已经在真实 VPS 上验证。

Tailscale、云防火墙和 Caddy 的安全边界随后已完成，结果见下一节。

## 10. 远程接入验收结果

最终链路为：

```text
iPhone Safari
→ Tailscale Grant
→ Caddy 的 Tailscale-only HTTPS listener
→ 127.0.0.1:4517 上的 Cinba Core
```

现场验收结果：

- Tailscale MagicDNS HTTPS 返回有效证书，`GET /healthz` 返回 `200`、准确 revision 与
  `safeToRestart`；
- Caddy 只在 Tailscale IPv4 上为 Cinba 接收 `tcp:443`，Core 继续只监听 loopback；
- 手机能加载 Web UI，并通过 WebSocket 获取 Core 身份与 provider 列表；
- 手机断开 Tailscale 后入口不可达，重新连接后入口恢复；
- 已加载页面在 Tailscale 短暂断开再恢复时，无需刷新即可自动重连；
- 三个既有公网 Caddy 站点在升级、reload 和 Cinba 接入后保持原有行为；
- 没有给 Cinba 新增云防火墙端口，没有使用 webhook，也没有让 GitHub 主动登录 VPS。

产品级验收随后也已完成，结果见第 12 节。真实凭据仅由用户在 Cinba 界面中输入，没有进入本文、
终端输出或 Git。

## 11. 候选检查失败保护实测

一次后续发布在候选 release 的 `test:e2e` 阶段遇到 Pi 子进程启动超时。部署器将目标记为
`failure: checks` 并隔离该 revision；`current`、运行中的 Core 和上一成功 release 均未改变。

同一 revision 随后在同一台 VPS 的隔离 worktree 中单独重跑 5 个 E2E，全部通过，失败项恢复为
亚秒级完成，因此没有根据一次瞬时抖动放宽超时或跳过门禁。诊断 worktree 已在核对路径与 revision
后移除。下一次普通向前提交会提供新的部署目标，失败 revision 本身仍不被 timer 重复尝试。

## 12. 产品链路与修复发布验收

2026-09-14 在真实 VPS、真实 provider、iPhone Safari 与 VPS TUI 上完成最后一轮验收：

- TUI 能接收终端的 bracketed paste，凭据输入只显示掩码，保存后 provider 可用；
- 选择模型后能完成普通对话；
- `pwd` 这类只读命令按策略直接执行；
- `sudo` 这类提权命令会触发权限确认，允许与拒绝两条路径均已验证；
- 手机 Web 与 VPS TUI 查看同一会话时，消息和工具结果会实时同步；
- 没有模型时发送 prompt 会明确提示先配置 provider，并恢复 idle，不再留下假的 answering 状态；
- 自动部署在旧版残留假忙状态下完成候选检查并等待 draining；经一次明确授权的受控停止后切换成功，
  `current`、`/healthz` 与 `/deployment-status` 均指向目标 revision，HTTPS 返回 `200`；
- `master` 与 `prod` 最终指向同一 revision，update timer 回到等待状态。

至此，首次 bootstrap、Tailscale-only HTTPS、主动拉取部署、故障隔离、断线恢复、凭据配置、权限门
和跨客户端共享会话均已在真实环境中验证。形态 C 第 3 步没有剩余的部署阻塞项。
