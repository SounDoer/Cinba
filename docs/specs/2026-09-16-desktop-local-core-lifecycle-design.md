# Desktop 本机 Core 生命周期修正

日期：2026-09-16

状态：已实施；相关测试与完整 `npm run check` 通过

## 1. 用户规则

由 `@cinba/core-manager` 管理的本机 Stable Core 一律使用 `on-demand`：

- Desktop、Web 或 TUI 需要本机 Core 时自动启动；
- 任一客户端仍连接时继续运行；
- 最后一个客户端断开后，安全空闲十分钟才退出；
- 正在回复、compact、恢复会话或等待权限确认时不退出；
- Desktop 关闭窗口、正常退出或意外结束都不会留下永久运行的本机 Core。

本机 Desktop 不再提供把 Core 提升为 `persistent` 的入口。`persistent` 只保留给 VPS systemd、开发
服务等有独立管理入口的部署，不修改 Sync Server 的生命周期。

## 2. Desktop 行为

打开内置的 This PC / This Mac Profile 时，Desktop 调用无 lifetime 参数的 `ensureLocalCore()`。
Tray/Menu Bar 的 `Start Local Core` 使用同一路径；它只提前启动 Core，不承诺永久驻留。普通
`Quit Desktop` 只退出 Desktop：若 Web、TUI 或任务仍在使用 Core，它继续运行；否则进入既有的十
分钟安全空闲期。

Tray/Menu Bar 定期检查现有本机 Core。若发现由当前 manager 管理的历史 `persistent` Core，只把
它原地降为 `on-demand`，不启动不存在的 Core，也不中断现有客户端或任务。原来的
`Stop Local Core and Quit Desktop` 组合动作删除；需要立即停止时先选择
`Stop Local Core Gracefully`，普通退出不承担停止其它客户端的职责。

## 3. 代码版本一致性

manager 启动本机 Core 时解析当前 checkout 的完整 Git commit，并通过 `CINBA_REVISION` 让
`/healthz` 报告该 revision。每次 `ensureLocalCore()` 都比较运行实例与当前 checkout：

- revision 相同：复用进程；
- manager-owned、revision 不同且 `safeToRestart`：请求 graceful drain，确认旧端口释放后启动当前
  revision；
- manager-owned、revision 不同且忙碌：不发送 stop，返回可操作错误，用户稍后 Retry；
- external Core revision 不同：明确拒绝复用，不凭端口或 PID 终止它；
- draining Core：在启动锁内等待 graceful stop，不把它误报成可连接的现成 Core。

停止与替换都处于现有启动锁保护范围内。安全性最终由 Core 的 drain 决定：即使 health 检查后刚好
开始了新工作，也只会等待工作完成，不会强杀 PID。

## 4. 迁移与边界

历史 manager-owned `persistent` Core 在 Desktop 状态刷新或任一本机入口调用
`ensureLocalCore()` 时降为 `on-demand`。没有 control token、记录不匹配或不支持当前控制协议的
Core 继续视为 external；当前版本不会增加 Windows PID 强杀旁路。

Git revision 表达已提交 checkout/release 的身份，不试图为 dirty worktree 发明第二套 release
编号。仓库的正式完成路径仍是检查通过后提交到 `master`。

## 5. 验证

- 新启动的本机 Core 固定收到 `on-demand` 与当前 revision；
- 已有 persistent Core 原地降级，不更换 PID；
- 停止状态的 Core 只做状态检查，不被 Tray 刷新启动；
- 相同 revision 复用；安全旧 revision graceful restart；忙碌旧 revision 不收到 stop；
- external 旧 revision 不停止、不替换；
- draining 与并发启动最终只产生一个新 Core；
- Desktop Local 使用默认 ensure，Remote Profile 不进入本机生命周期；
- Server 的十分钟安全空闲规则以及 VPS/systemd persistent 默认值不变。
