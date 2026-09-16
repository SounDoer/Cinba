# Windows Tray 与 macOS Menu Bar 共用 Desktop 控制器

日期：2026-09-14

状态：历史设计；本机 persistent 生命周期已由
`2026-09-16-desktop-local-core-lifecycle-design.md` 取代

> 本文记录 Desktop 跨平台控制器的形成过程。第 2、3、7 节中的 Desktop persistent 与退出语义
> 不再是当前规则；现在所有 manager-owned 本机 Core 均为 on-demand。

## 1. 产品形态

Mac 是用户主动使用的个人电脑，不按 VPS 的无人值守服务器形态部署。Stable Core 由可见的 Cinba
Desktop 管理：Windows 上入口位于 System Tray，macOS 上入口位于 Menu Bar。

```text
Cinba Desktop
├── Windows System Tray
└── macOS Menu Bar
        │
        ▼
@cinba/core-manager → Stable Core 127.0.0.1:4517
```

Desktop 提供打开窗口、启动、查看、优雅停止和日志入口。Core 仍是独立进程；关闭 Web 窗口不会
关闭 Desktop 控制器，也不会直接杀死 Core。

本阶段不使用 `launchd` 直接托管 Core。未来的 Open at Login 只能作为用户主动选择的 Desktop
启动设置；Electron 官方也说明未打包、签名和 notarize 的 macOS 应用无法可靠使用登录启动，因此
应在正式打包之后实现。

## 2. Stable 的两种生命周期

普通本机入口与 Desktop 表达不同意图：

```text
npm start / cinba TUI
→ on-demand
→ 最后一个客户端断开 10 分钟后安全退出

Cinba Desktop 中的 Start Core / Open Cinba
→ persistent
→ 没有客户端时仍保持远程可用
→ 直到用户选择 Stop Core Gracefully
```

两者仍是同一个 Stable instance，使用 4517、`~/.cinba` 和 `~/.pi/agent`，不能同时启动两个。
core-manager 启动进程时记录真实 lifetime；本机 token 控制面同时支持 on-demand 和 persistent Core。

若 Desktop 接管一个已经运行的、由同一 core-manager 管理的 on-demand Core，不重启和断开现有
客户端，而是通过 token 保护的 loopback 控制入口把 lifetime 原地提升为 persistent。

## 3. Desktop 退出语义

菜单提供两个清楚分开的动作：

- `Quit Desktop`：只退出图形控制器，Core 保持当前状态，避免意外中断远程任务；
- `Stop Core and Quit Desktop`：先请求 graceful stop，完成后退出控制器。

用户也可以单独选择 `Stop Core Gracefully`，保持 Desktop/Menu Bar 继续运行。关闭 BrowserWindow
只销毁窗口和它的 WebSocket，不等价于上述任一退出动作。

## 4. 跨平台 Desktop

保留现有 Electron `Tray`、菜单、单实例锁和窗口控制器，去掉 Windows-only 产品限制：

```text
cinba desktop  → Windows/macOS，启动 Desktop 并打开窗口
npm run desktop → 开发仓库中的 Desktop 入口
cinba-desktop.cmd / cinba-desktop.command → Windows/macOS 双击入口
```

macOS 在应用就绪后隐藏 Dock 图标，以 Menu Bar 为主要入口。Electron 官方建议 macOS Tray 使用
Template Image 适配明暗菜单栏，因此 macOS 将生成的图标标记为 template；Windows 继续显示状态
颜色。菜单文字统一使用 Desktop，不把 macOS 用户暴露给 Windows 的 Tray 术语。

## 5. 安全边界

- Server 继续只监听 `127.0.0.1`；本阶段不配置 Tailscale 或 Caddy。
- lifetime 修改入口只在 manager 提供随机 token 时存在，并要求 Bearer token。
- persistent 不代表跳过 Permission Gate；工具权限规则完全不变。
- external Core 仍只读展示，当前 Desktop 不持有其 token，不得停止或修改 lifetime。
- Stop 继续进入现有 draining，不按 PID 强杀。

## 6. VPS 与 Dev

VPS systemd Core 没有本机控制 token，因此新增控制路径不存在，persistent 行为不变。

`npm run dev` 继续使用隔离的 4518 与 `~/.cinba/dev`。Desktop 只管理 Stable 4517，两者可同时
运行。

## 7. 验证

- core-manager 默认启动仍是 on-demand。
- Desktop 启动的是 token 保护的 persistent Core。
- 已运行的 managed on-demand Core 能原地提升为 persistent，不改变 PID。
- external Core 不能被提升或停止。
- persistent Core 可由相同 token 查询并 graceful stop。
- Windows Tray 现有菜单与单实例行为不回归。
- macOS 能显示 Menu Bar 图标、打开窗口、启动和停止 Stable Core。
- 关闭窗口后 Menu Bar 和 persistent Core 继续存在。
- Stable 运行时 `npm run dev` 可继续使用 4518。
- `npm run check` 完整通过。
