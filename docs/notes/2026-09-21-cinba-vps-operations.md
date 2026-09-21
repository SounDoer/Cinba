# Cinba VPS 运维备忘

日期：2026-09-21

状态：`v0.1.1` 已在真实 VPS 完成安装、Sync 设置、远程访问、两次重启和旧部署退役验收

这份备忘记录正式 Headless artifact 在个人 VPS 上的日常运维方法。Cinba 只管理当前用户下的程序、
Core 与 Sync Host；Tailscale、Caddy、DNS、TLS、防火墙和系统账号始终由 VPS 管理员独立维护。

文中的域名、地址和用户名均为占位符。真实入口、身份与凭据不进入公开仓库。

## 运行形态

- Cinba 安装在普通用户目录，不以 root 运行；
- 稳定 launcher 为 `~/.local/bin/cinba`，版本化 payload 位于 `~/.local/lib/cinba/releases/`；
- Core 与 Sync 分别由 `cinba-core.service`、`cinba-sync.service` 两个 systemd user unit 托管；
- Background 模式需要 `loginctl enable-linger <user>`，使服务在 SSH 退出和 VPS 重启后继续运行；
- Core 固定监听 `127.0.0.1:4517`，Sync 固定监听 `127.0.0.1:4518`；
- Caddy 只把用户已有的 HTTPS 入口反向代理到这两个 loopback 端口；Cinba 不接管网络入口。

## 日常检查

```sh
cinba version
cinba doctor
cinba core status
cinba sync status --json

systemctl --user is-enabled cinba-core.service cinba-sync.service
systemctl --user is-active cinba-core.service cinba-sync.service
ss -ltn '( sport = :4517 or sport = :4518 )'
```

健康状态应满足：Doctor 全部 PASS，两个 unit 为 `enabled` 与 `active`，Sync 为 `ready`、`healthy`，
两个端口只绑定 loopback。

服务日志：

```sh
journalctl --user -u cinba-core.service -u cinba-sync.service --since today
```

## 生命周期操作

```sh
# Core
cinba core mode background
cinba core mode on-demand
cinba core stop

# Sync Host
cinba sync mode background
cinba sync mode on-demand
cinba sync mode disabled
```

`disabled` 只停用 Sync 服务，不删除 Host authority。永久删除必须使用 `cinba sync delete` 并完成独立
确认。普通 `cinba uninstall` 保留用户数据；`cinba uninstall --purge` 才删除全部 Cinba 数据。

## 更新

```sh
cinba update
```

更新只接受正式、非 draft、非 prerelease 的 GitHub Release，并在安装前校验 release identity、manifest
与 SHA-256。更新期间不要手工替换 `releases/` 或 `current.json`；失败时保留日志，由稳定 launcher 负责
回滚和恢复原 lifecycle mode。

`v0.1.1` 已知限制：从 SSH 中直接确认 `cinba update` 后，命令行 handoff 可能在 SSH 退出时中断并
遗留一个无 TTY 的 TUI；旧版本和数据会安全保留。下一版本包含修复。在此之前可停止 Core/Sync user
unit，重新执行目标正式版本的公开 bootstrap，再启动两个 unit；不要手工改 current pointer。

## 一致性备份

备份包含管理员验证数据、Sync authority 与 Core credential，应视为敏感文件。备份时短暂停止 unit，
但不改变 Cinba 记录的 background mode：

```sh
umask 077
backup_root="$HOME/backups/cinba"
stamp="$(date +%Y%m%d-%H%M%S)"
archive="$backup_root/cinba-vps-$stamp.tar.gz"

mkdir -p "$backup_root"
chmod 700 "$HOME/backups" "$backup_root"

systemctl --user stop cinba-sync.service cinba-core.service
tar -C / -czf "$archive" -- \
  "home/$USER/.config/cinba" \
  "home/$USER/.config/systemd/user/cinba-core.service" \
  "home/$USER/.config/systemd/user/cinba-sync.service" \
  "home/$USER/.local/share/cinba" \
  "home/$USER/.local/state/cinba" \
  "home/$USER/.local/lib/cinba/current.json"
chmod 600 "$archive"
systemctl --user start cinba-core.service cinba-sync.service

sha256sum "$archive"
cinba doctor
```

同盘备份只能防误操作，不能防 VPS 或磁盘损坏。稳定后应从个人设备把 archive 加密复制到异机存储；
不要把它提交到 Git、上传到公开附件或留在公司设备。恢复前先校验 SHA-256，停止两个 unit，把现有数据
移动到独立回退目录，再从 archive 恢复；不要直接覆盖一个仍在运行的 Host。

## Caddy 与 Tailscale 启动顺序

若 Caddy 精确绑定 Tailscale 地址，开机时可能早于该地址就绪并报
`bind: cannot assign requested address`。这是网络基础设施问题，不应写进 Cinba 安装器。可为 Caddy
增加 systemd override：

```ini
[Unit]
After=tailscaled.service
Wants=tailscaled.service

[Service]
Restart=on-failure
RestartSec=5s
```

保存到 `/etc/systemd/system/caddy.service.d/tailscale.conf` 后执行：

```sh
sudo systemctl daemon-reload
sudo systemctl restart caddy
systemctl is-active caddy tailscaled
```

重启验收必须同时检查 Caddy、Tailscale、Core、Sync 和两个 HTTPS 入口，不能只看 Cinba Doctor。

## 故障定位

- Core/Sync unit active 但 Doctor 失败：先等数秒再查日志；进程启动与健康检查之间存在短暂窗口；
- 端口被占用：用 `ss -ltnp` 找到所有者，不读取、停止或修改其他系统用户的 Cinba；
- HTTPS 不通而 loopback 健康：检查 `systemctl status caddy tailscaled`，不要修改 Cinba payload；
- Sync 显示 `setup-required`：使用创建时一次性显示的 Setup Code 在 sync-web 完成管理员设置；
- Sync 显示未创建：运行 `cinba sync create --public-origin <https-origin>`，不要手工制造状态文件；
- 更新或安装失败：保留 `~/.local/state/cinba/` 中的事务和失败记录，不直接删除当前 release。

## 旧部署清理

旧源码 unit、timer、checkout、私有 Node 和部署脚本必须先停止、禁用并移动到精确的隔离目录。新 artifact
经过安装、远程访问和重启验收后，才永久删除隔离目录。删除前逐项解析绝对路径，确认全部位于旧用户的
Cinba 范围；不递归删除整个 home，也不删除 Tailscale、Caddy 或其他应用数据。

本次验收先把旧部署移动到隔离目录，确认正式部署、手机管理、TUI 和两次重启均正常后，再永久删除旧
unit、每分钟 update timer、checkout、release、私有 Node、npm 残留和隔离目录。旧专用系统账户已在
用户明确确认后连同同名组、SSH key 和 home 删除；当前部署仍由安装用户自己的账户运行。

## 2026-09-21 验收快照

- 正式版本：`0.1.1 (a54322a6a3f6697e563162e13b4388b0c5228a9d)`；
- `cinba-core.service`、`cinba-sync.service`：`enabled`、`active`；
- Doctor：`ready`；Sync Host：`ready`、`healthy`、Background、连接一个 Core；
- Core/Sync：只监听 `127.0.0.1:4517/4518`；远程 HTTPS 和手机登录通过；
- Caddy：等待 Tailscale 并在失败后重试，两次真实 VPS 重启通过；
- 一致性备份：服务器本地 archive，权限 `600`，SHA-256
  `a8191c64c7dd2cb8461ae298295f5ae38add20dd63977369baf74178a948d2ec`；
- 旧部署和专用账户：已永久删除；
- 尚未执行：从个人设备制作加密异机备份。
