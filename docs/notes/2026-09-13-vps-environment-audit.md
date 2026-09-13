# VPS 首轮环境盘点

日期：2026-09-13

状态：首轮无提权只读检查已完成；管理员权限、Tailscale 控制面与云防火墙仍待核对

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

VPS 当前没有可用的 Tailscale 客户端，也没有 `tailscaled.service`。因此本轮无法获得：

- VPS 的 Tailscale IPv4 地址；
- MagicDNS 完整名称；
- 节点在线与登录状态；
- Tailscale HTTPS 证书权限状态。

Grants／ACL 是 tailnet 控制面策略，不能从这台尚未加入 tailnet 的 VPS 上完整读取。安装前还需
在 Tailscale 管理后台核对现有策略，避免新规则与已有宽泛规则叠加后扩大访问范围。

## 4. Caddy 与既有应用

- Caddy 版本为 2.6.2。
- `caddy.service` 正在运行并已启用开机启动。
- unit 来自系统级路径 `/usr/lib/systemd/system/caddy.service`。
- 主配置为 root 所有、普通用户可读的 `/etc/caddy/Caddyfile`。
- 当前配置包含三个既有站点：两个反向代理到 loopback 后端，一个提供静态文件。
- 两个既有后端分别监听 `127.0.0.1:3000` 和 `127.0.0.1:8080`。
- Caddy 管理接口监听 `127.0.0.1:2019`。
- Caddy 当前在所有网卡监听 `80/tcp`、`443/tcp`，并监听 `443/udp`。

现有 Caddy listener 与“Cinba 站点只绑定 Tailscale IP”的目标存在配置层面的相互影响。首次
部署不能直接追加未经验证的站点块；必须保留三个既有站点，并在真实 Tailscale IP 已知后使用
`caddy adapt`、配置验证和 listener 检查确认最终形状。

## 5. 防火墙与端口

- UFW 已安装且 service 状态为 active。
- 普通用户无权读取 UFW 的具体规则，本轮没有绕过该限制或使用 `sudo`。
- 当前对外监听包括 `22/tcp`、`80/tcp`、`443/tcp` 和 `443/udp`。
- `3000/tcp`、`8080/tcp` 和 `2019/tcp` 只监听 loopback。
- Cinba 的 `4517/tcp` 当前没有 listener，符合尚未部署的状态。
- 云厂商安全组无法仅从 VPS 内部可靠确认，仍需在云控制台单独核对。

后续使用管理员权限时需要只读检查 UFW／nftables 的实际规则。无论现状如何，本阶段都不给
Cinba 新开公网端口。

## 6. systemd user service 条件

- systemd user manager 可以正常运行。
- 当前 SSH 用户的 user manager 在登录期间为 running，但没有启用 linger。
- `cinba` 用户尚不存在，因此也没有 `/run/user/<uid>`、user manager 或 linger 状态。

采用设计中的 systemd user service 可行。首次安装仍需要管理员创建 `cinba` 普通用户，并执行
`loginctl enable-linger cinba`，这样退出管理 SSH 后，Cinba 服务和更新 timer 才能继续运行。

## 7. 用户与 `/home` 布局

- 系统目前有四个带真实 home 和交互 shell 的普通用户。
- 其中两个既有用户属于 `sudo` 组；当前用于盘点的部署用户不属于 `sudo` 组。
- `/home` 下已有四个互相独立、权限为 `0750` 的用户目录。
- `/home/cinba` 尚不存在。

因此首次 bootstrap 不能由当前部署用户直接完成。需要先恢复一个现有管理员账号的 key／sudo
访问，或通过云厂商控制台进入 root／救援通道，再创建独立的 `cinba` 普通用户。不能为了省事让
Cinba 使用现有管理员账号或 root 运行。

## 8. 下一步待确认

1. 找到可用的管理员登录方式，并只读检查其 sudo 能力。
2. 使用管理员权限读取 UFW／nftables 规则和 Caddy systemd 环境，但暂不修改。
3. 在 Tailscale 管理后台核对 tailnet、MagicDNS、HTTPS 与现有 Grants／ACL。
4. 根据真实管理员入口设计并逐项执行首次 bootstrap；所有 sudo 动作执行前单独解释和确认。

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

尚未完成的安全边界仍是 Tailscale 安装与控制面策略、UFW／云安全组复核，以及不影响既有应用的
Caddy Tailscale-only listener 配置。
