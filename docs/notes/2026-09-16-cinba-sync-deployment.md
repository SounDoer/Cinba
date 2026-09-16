# Cinba Sync 部署与验收记录

本文记录第一版 Sync Server 的等价部署形状。Sync Server 始终是独立常驻服务，不进入 Core 的
on-demand 生命周期，也不随 Web、TUI 或 Desktop 窗口关闭。

## 共同约束

- 服务只允许监听 `127.0.0.1`、`localhost` 或 loopback IPv6；程序会拒绝 `0.0.0.0` 和普通网卡地址。
- 远程管理必须使用 HTTPS reverse proxy。配置 HTTPS public origin 后，Server 同时检查
  `X-Forwarded-Proto: https` 和匹配的 `X-Forwarded-Host`。
- 权威状态默认位于 `~/.cinba-sync`，权限只授予运行服务的系统用户。
- `CINBA_SYNC_PUBLIC_ORIGIN` 必须是客户端实际访问的根 origin，不能带路径。
- Sync 与 Core 可以来自同一 release，但使用不同进程、端口、状态目录和健康检查。

## VPS：systemd user service + Caddy + Tailnet

以非 root 的 `cinba` 用户安装仓库中的 `packages/deploy/systemd/cinba-sync.service`：

```sh
install -d -m 700 ~/.config/cinba ~/.config/systemd/user
install -m 644 packages/deploy/systemd/cinba-sync.service ~/.config/systemd/user/
printf '%s\n' 'CINBA_SYNC_PUBLIC_ORIGIN=https://sync.example.ts.net' > ~/.config/cinba/sync.env
chmod 600 ~/.config/cinba/sync.env
systemctl --user daemon-reload
systemctl --user enable --now cinba-sync.service
curl --fail http://127.0.0.1:4518/health
```

Caddy 示例位于 `packages/deploy/caddy/Caddyfile.sync.example`。站点必须绑定 Tailnet/LAN 接口，
只把流量反代到 `127.0.0.1:4518`；不要开放 Sync 的裸 HTTP 端口。Caddy 的 `reverse_proxy` 会提供
Server 校验所需的 forwarded headers。

检查服务和初始化状态：

```sh
cinba sync status
journalctl --user -u cinba-sync.service
```

release 切换会先验证新 Core，再仅在 `cinba-sync.service` 原本 active 时重启它，并验证 loopback
`/health`。没有启用 Sync 的主机不会被部署流程擅自启动 Sync。

## 家用 Mac

复制 `packages/deploy/launchd/com.cinba.sync.plist.example` 到
`~/Library/LaunchAgents/com.cinba.sync.plist`，把示例用户名、checkout 路径和 public origin 改为本机
实际值，再执行：

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cinba.sync.plist
curl --fail http://127.0.0.1:4518/health
```

远程设备仍通过 Tailnet/LAN HTTPS proxy 访问。只在这台 Mac 自己使用时，可以把 public origin 设为
`http://127.0.0.1:4518`，但其它设备不能使用这个 loopback URL。

## 无 VPS

任选一台常驻 Mac 或 Linux 主机承担同一个 Sync Server 角色即可；协议、Core enrollment、backup 和
restore 都不依赖 VPS。Windows 当前可以运行 `cinba sync serve` 做前台托管，但第一版没有增加
Windows Service 安装器。

## 备份、迁移与 URL 变化

```sh
CINBA_SYNC_MIGRATION_PASSWORD='一次性强密码' cinba sync backup /private/path/sync.backup
CINBA_SYNC_MIGRATION_PASSWORD='一次性强密码' cinba sync restore /private/path/sync.backup
```

迁移密码通过环境变量传入，避免进入命令参数。`restore --force` 会先把原目标目录改名保留；恢复完成
后应核对保留目录再决定何时清理。若 public URL 不变，原 Core credential 继续有效；URL 改变时只需
在各 Core 修改 connection URL，不重新 enrollment，旧 Server 也不会自动重定向。

## 尚需实机完成的验收

自动测试覆盖独立进程、维护只读、加密备份恢复和多 Core 协议流程，但下列项目必须在目标设备完成：

- VPS 上真实 Tailscale certificate、Caddy interface bind 与 systemd 重启；
- Windows 和 macOS Desktop 对同一 HTTPS Sync origin 的 cookie/login 行为；
- macOS launchd 重启与睡眠唤醒；
- 手机浏览器的 Setup、Login、key 替换和 enrollment approval。
