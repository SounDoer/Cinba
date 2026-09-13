# 统一产品 CLI 入口

## 背景

Cinba 已经有三类命令入口：npm 生成的 Windows 全局 shim、仓库根目录的双击脚本，以及 VPS
用户目录下的 POSIX launcher。它们最终都能启动 TUI，但并没有先经过同一个产品命令入口：只有
全局 `cinba` 进入 `scripts/cinba.ts`，其余入口直接调用 `scripts/launch.ts`。

这使 `scripts/cinba.ts` 只能通过改写 `process.argv` 再导入 launcher 来复用启动逻辑，也使未来新增
子命令时需要同时判断多个平台入口。

## 目标结构

职责按三层分开：

1. 平台适配层只解决操作系统怎样找到 Cinba，并提供平台默认值。
2. `scripts/cinba.ts` 是唯一产品 CLI 入口，负责解析 `tui` 与 `core` 命令。
3. `scripts/launch.ts` 提供可导入的 Web、开发模式和 TUI 启动函数，负责进程编排而不解析产品命令。

Windows npm shim 继续由 `package.json#bin` 生成；`cinba-tui.cmd` 和 VPS launcher 也改为进入
`scripts/cinba.ts`。VPS launcher 只额外提供 `/home/cinba/Cinba` 这一平台默认项目目录。

开发者入口 `npm start`、`npm run dev` 和 `npm run tui` 仍可直接调用 `scripts/launch.ts`。它们是仓库
脚本，不是另一套产品 CLI。

## 命令兼容

- `cinba`：在默认项目目录启动 TUI；Windows 默认当前目录，VPS 默认 `$HOME/Cinba`。
- `cinba tui [project]`：显式启动 TUI。
- `cinba [project]`：保留单参数项目目录的简写。
- `cinba core status|start|stop`：保持现有 Core 管理命令。

## 验证

- 单元测试覆盖命令解析和 `launch.ts` 的可导入行为。
- Windows batch 测试确认双击入口进入 `scripts/cinba.ts`。
- deploy 测试确认 VPS wrapper 使用受管 Node、当前 release、默认项目目录并透传参数。
- 完成所有提交后运行 `npm run check`，通过后才推送。

## 边界

本次不新增产品命令，不改变 Core 生命周期，不部署到 VPS，也不修改 prod、Caddy 或 Tailscale。

## 实施结果

已按目标结构完成：`scripts/launch.ts` 可安全导入并导出三个启动函数；`scripts/cinba.ts` 直接调用
`launchTui()`；Windows 双击入口和 VPS wrapper 都已汇入产品 CLI。平台回归测试、CLI 单元测试与
类型检查通过，最终以仓库 merge gate 结果为准。
