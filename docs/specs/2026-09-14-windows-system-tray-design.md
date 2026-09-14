# Windows 系统托盘设计

日期：2026-09-14

状态：已实施；自动化检查与 Windows 真实进程生命周期验证通过

## 1. 目标

为本机共享 Core 提供一个常驻但轻量的 Windows 图形入口。托盘只展示和调用已有的本机生命周期
能力，不成为第二套进程管理器，也不改变 VPS 上由 systemd 管理的 persistent Core。

产品入口新增：

```text
cinba tray
```

该命令先构建 Web UI，再确保托盘进程存在；它不自动启动 Core，也不自动打开窗口。根目录的
`cinba-tray.cmd` 提供同一入口的双击方式。直接运行 Desktop 时继续打开窗口；点击托盘中的
`Open Cinba` 时调用 `ensureLocalCore()` 后创建窗口。

## 2. 职责与状态

托盘位于现有 `@cinba/desktop`，所有 Core 操作继续经过 `@cinba/core-manager`。Desktop 原生层按
职责拆成三个模块：`main.ts` 只负责 Electron 启动与单实例，`tray.ts` 负责托盘和 Core 控制，
`window.ts` 负责 BrowserWindow 的创建、聚焦和销毁：

```text
main.ts ──► tray.ts ──► @cinba/core-manager ──► @cinba/core-client ──► Core
   │          │
   └──────────┴──────► window.ts ──► BrowserWindow ─────────────────► Web UI
```

托盘定期调用 `inspectLocalCore()`，映射下列状态：

- stopped：Core 不存在，可启动。
- running：受本 checkout 管理的 on-demand Core，可 graceful stop。
- draining：Core 已拒绝新工作，正在等待安全退出。
- external：4517 上是可用 Cinba Core，但不属于当前 manager；只读展示，不能停止。
- error：最近一次探测或操作失败；保留最后一个已知状态并显示错误。

starting 与 stopping 是托盘自身操作的短暂状态，不进入共享协议。

## 3. 窗口与进程生命周期

托盘进程和 Core 进程彼此独立：

- 关闭 BrowserWindow 时销毁窗口、释放 WebSocket，但 Electron 托盘继续存在。
- 不能只隐藏窗口，否则隐藏的 WebSocket 会让 Core 永远保留客户端。
- Core 仍按现有 10 分钟安全空闲规则自行退出。
- 再次打开窗口时重新调用 `ensureLocalCore()`，必要时拉起 Core。
- `Quit Tray` 只退出托盘，不强制停止 Core；Core 自己完成空闲退出。
- `Stop Core Gracefully` 只调用 `stopLocalCore()`，不按 PID 强杀。

Electron 使用单实例锁。重复执行 `cinba tray` 是幂等操作；直接再次启动 Desktop 时让已有实例打开并
聚焦窗口。

## 4. 第一版菜单

```text
Open Cinba
────────────
Core: <state>
PID: <pid>                    （可用时）
Clients: <count>              （可用时）
<recent error>                （失败时）
────────────
Start Core
Stop Core Gracefully
Refresh Status
Open Core Log
────────────
Quit Tray
```

状态映射保持为与 Electron 无关的纯函数并覆盖单元测试。托盘图标和菜单由映射结果生成；轮询使用普通
HTTP 健康检查，不建立 WebSocket，因此不会影响 Core 的客户端计数和空闲退出。

## 5. 本次边界

第一版不做开机自启、通知气泡、安装器、自动更新或远程 Core 控制，不增加 runtime dependency，
不修改 contract。后续应在 Desktop 有稳定的打包分发方式后再考虑登录自启。

## 6. 验收

- `cinba tray` 启动后命令行立即返回，且只存在一个托盘实例。
- Core 未运行时显示 stopped，并可从菜单启动。
- managed Core 显示 PID、客户端数，可 graceful stop。
- external Core 可识别但不可停止。
- 关闭窗口后托盘仍存在，窗口持有的 WebSocket 已断开。
- Core 空闲退出后托盘自动更新为 stopped；再次打开窗口会重新启动 Core。
- `npm run check` 全绿。
