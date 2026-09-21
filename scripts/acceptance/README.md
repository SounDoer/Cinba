# 发布验收脚本

这些脚本用于每个正式版本在真实系统上的验收，结果回写到
`docs/notes/2026-09-18-cinba-product-distribution-verification.md` 或对应版本的验收记录。它们不属于
`npm run check`，也不会在 CI 中运行。

先从 Draft Release 下载 artifact 与 `SHA256SUMS`，并核对校验值。

## Windows 干净账号：`windows-acceptance.ps1`

在一个标准（非管理员）用户或干净虚拟机中，把脚本和 `.exe` 放在同一目录，按脚本开头注释的顺序分
阶段运行：`pre` → 双击安装 → `installed` → `background` → 注销并重新登录 → `after-signin` →
`uninstall` → 重装 → `reinstalled` → `purge`。每项输出 PASS / FAIL，并追加到同目录的
`cinba-acceptance.log`。SmartScreen、UAC 与 TUI、Desktop 的交互仍需人工确认。

## Linux 容器：`linux-container-probe.sh`

在没有 systemd、没有网络的干净 Ubuntu 容器中，以普通用户验证离线安装、无自动启动、
没有在用户 home 之外写入、PATH 标记块、`doctor`、TUI、On-demand Core、Background 不可用时的
说明、离线更新错误、卸载保留数据、重装与 purge：

```sh
docker run --rm --network none -v "$PWD/dist-download:/probe:ro" \
  -v "$PWD/scripts/acceptance/linux-container-probe.sh:/probe.sh:ro" ubuntu:24.04 sh /probe.sh
```

`dist-download` 目录中需要有 `Cinba-<version>-linux-x64-gnu.tar.gz` 与 `SHA256SUMS`。

## Linux systemd：`linux-systemd.Dockerfile` 与 `linux-systemd-probe.sh`

构建镜像时需要联网安装 systemd；测试时容器以 systemd 为 PID 1、没有网络：

```sh
docker build -t cinba-probe-systemd -f scripts/acceptance/linux-systemd.Dockerfile scripts/acceptance
docker run -d --name cinba-sd --privileged --cgroupns=host --network none \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw -v "$PWD/dist-download:/probe:ro" cinba-probe-systemd
docker cp scripts/acceptance/linux-systemd-probe.sh cinba-sd:/systemd-probe.sh
docker exec cinba-sd bash /systemd-probe.sh before-reboot
docker restart cinba-sd
docker exec cinba-sd bash /systemd-probe.sh after-reboot
docker rm -f cinba-sd
```

它覆盖没有 linger 时的诊断与交互式拒绝、Background、登出后继续运行，以及真实 Sync Host 的
`create/bootstrap → background → 重启恢复 → disable/enable`。普通卸载必须保留 Host 配置和
authority，重装后识别同一 Host 并以安全的 disabled 模式恢复；purge 最终删除全部 Host 数据。

容器不能代替真实 VPS 上的 SSH 断开、主机重启和正式发布后的 bootstrap 一行命令，这些仍需在真实
主机上验收。
