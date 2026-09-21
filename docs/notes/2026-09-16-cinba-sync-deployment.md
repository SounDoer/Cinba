# Cinba Sync 部署与验收记录

日期：2026-09-16

最后更新：2026-09-21

状态：历史实施记录；基于源码 checkout、`packages/deploy` 和 `prod` 分支的操作说明已退役，
不得用于当前正式产品。

## 历史结论

第一版 Sync Server 已验证下列边界：

- Sync Server 是与 Core 平级的独立常驻进程，使用独立的端口、状态目录和健康检查；
- 服务只监听 loopback；远程访问必须由外部 HTTPS reverse proxy 提供，不直接暴露裸
  HTTP 端口；
- Sync 权威数据、加密 key、Core enrollment、管理端身份和备份恢复均不依赖普通 Core；
- systemd user service、launchd、Caddy 与 Tailscale 形状曾在第一版源码部署链中验证。

这些结论仍是后续设计输入，但旧的复制 unit、修改 checkout 路径、推进 `prod` 分支和
定时拉取源码不再是受支持的安装方式。

## 当前正式产品边界

`v0.1.0` 起，Sync 运行时与 `sync-web` 已进入统一 release payload，并复用正式 launcher、
安装目录和跨平台服务管理抽象。当前已有底层命令是：

```text
cinba sync serve
cinba sync mode
cinba sync mode disabled
cinba sync mode on-demand
cinba sync mode background
```

这些命令是安装与生命周期基础，不等于面向普通用户的 Sync 创建向导。正式产品尚未承诺
VPS、Tailscale、Caddy、TLS、LAN 或公网入口的自动安装与配置，也不再提供旧
`packages/deploy` 中的 unit 和 Caddy 示例。

旧记录中的 `cinba sync status`、`backup` 和 `restore` 属于源码时期命令形状，不是当前
正式 launcher 的公开命令，因此不再在这里作为部署步骤继续传播。

## 下一阶段

当前有效的产品方向见 `docs/specs/2026-09-17-cinba-sync-product-experience.md`。第一实施切片是
本机 GUI Sync：由 Desktop tray 按需托管 loopback-only Sync，完成本机创建、首次管理授权、
当前 Core 自动 enrollment、Disable 和独立确认的永久 Delete。

VPS/TUI 始终在线部署需要另行设计和验收；在那之前，不应把历史源码部署步骤
包装成正式产品功能。
