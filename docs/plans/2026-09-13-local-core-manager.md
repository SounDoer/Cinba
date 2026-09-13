# 本机共享 Core 生命周期方案

日期：2026-09-13

状态：已实施并通过真实后台进程验证；完整仓库检查见对应提交记录

## 1. 目标

本机的 Web、TUI 和 Desktop 共享一个 Core。任一原生客户端入口启动时：

1. 先确认 `127.0.0.1:4517` 上是否已有可用的 Cinba Core；
2. 有则直接复用；
3. 没有则只启动一个后台 Core，等待健康检查通过后再打开客户端；
4. 最后一个客户端断开后，Core 在 10 分钟内无人重新连接且没有回复或权限确认工作时自行退出；
5. 下一次打开任一客户端时重新启动。

VPS 的 Core 继续由 systemd 常驻运行，不参与本机按需启停。远程 Core 也只连接、不由本机管理。

## 2. 职责边界

```text
cinba / cinba-web.cmd / Desktop
              │
              │ ensureLocalCore()
              ▼
      @cinba/core-manager ────── 启动本机后台进程
              │                         │
              │ probeCoreHealth()       ▼
              ▼                    @cinba/server
      @cinba/core-client                 │
              ▲                         │ 零客户端且安全空闲 10 分钟
              └──── 客户端日常通信 ─────┘ 后自行退出

@cinba/deploy ── systemd ──► @cinba/server（persistent，不自动退出）
```

- `@cinba/server`：Core 的实现；拥有 HTTP、WebSocket、会话、Pi 进程以及最终退出决定。
- `@cinba/core-client`：与一个已经存在的 Core 通信；新增浏览器和 Node 都能使用的健康探测。
- `@cinba/core-manager`：只管理当前电脑上的 Core 进程；不实现协议，不管理 VPS。
- `@cinba/deploy`：安装和更新 VPS 的长期服务；本次不修改。

依赖只能是 `core-manager → core-client`。`core-client` 不能依赖 Node 进程或文件系统 API，否则 Web
客户端无法安全复用它。

## 3. Core 身份与启动并发

不能用“4517 端口打开”代替“Cinba Core 可用”。`core-client` 提供的健康探测必须请求
`/healthz`，校验 HTTP 状态和 JSON 形状。端口被其他程序占用时，manager 应明确报错，不再尝试
启动第二个进程。

两个客户端同时启动时可能都先看到 Core 不存在。`core-manager` 使用 `~/.cinba` 下的原子启动锁
串行化这段流程：

```text
第一次健康探测
→ 获取启动锁
→ 锁内再次健康探测
→ 仍不存在才 spawn
→ 等到 /healthz 成功
→ 释放锁
```

锁记录创建者 PID；只有确认该 PID 已不存在时才清理遗留锁。manager 将后台 Core 的 stdout/stderr
追加到 `~/.cinba/core.log`，避免无人持有的管道让进程退出，也给故障排查留下入口。运行记录只保存
PID、仓库目录和启动时间，不保存凭据或会话内容。

## 4. Server 生命周期模式

server 新增明确的生命周期模式，默认值必须是 `persistent`：

- `persistent`：保持现状；VPS systemd、开发模式和直接启动都不会因零客户端退出。
- `on-demand`：由 `core-manager` 启动；最后一个 WebSocket 客户端断开后开始计算 10 分钟宽限期。

到期后只有同时满足以下条件才开始现有的 draining 关闭流程：

- 客户端数为零；
- 所有会话均不在回复；
- 没有等待中的权限确认。

新客户端在宽限期内连接会清除空闲起点。若到期时仍有工作，Core 继续运行；工作完成后的维护检查
再退出。判断写成无副作用纯函数并覆盖单元测试，server 只负责提供实时状态和发起 drain。

这条 Core 空闲规则与已有的“单个会话 10 分钟没人查看就回收 Pi 子进程”是两件事：前者退出整个
本机服务，后者只节省某个会话的内存。

## 5. 客户端入口

> 2026-09-14 更新：`scripts/cinba.ts` 现在是产品 CLI 的统一解析入口；`scripts/launch.ts` 仍拥有
> 下列进程编排，并以可导入函数供产品 CLI 调用。

`scripts/launch.ts` 负责所有客户端进程编排：

- `start`：先 build Web，再 `ensureLocalCore()`，打开浏览器后结束 launcher；Core 留在后台。
- `tui`：默认连接本机时先 `ensureLocalCore()`，然后启动 TUI；设置 `CINBA_SERVER` 指向远程 Core
  时只连接远程地址，不启动本机 Core。
- `dev`：继续以前台方式同时持有 Core watch 和 Vite，不使用按需 Core。4517 已被普通 Core 占用时
  明确停止，不静默启动共享同一份 `~/.cinba` / `~/.pi` 数据的第二个 Core。
- Desktop 主进程：创建窗口前调用 `ensureLocalCore()`。

浏览器书签本身不能启动操作系统进程；本机 Web 的可靠入口是 `cinba-web.cmd` / `npm start`，已经
打开的网页在 Core 暂停后仍按现有自动重连逻辑等待下一次原生入口启动它。

## 6. 文件改动

```text
packages/core-client/src/
  core-health.ts              健康响应校验与探测
  core-health.test.ts

packages/core-manager/
  package.json
  tsconfig.json
  tsconfig.test.json
  src/config.ts               本机 URL、状态、锁和日志路径
  src/start-lock.ts           跨进程单实例启动锁
  src/start-lock.test.ts
  src/core-manager.ts         inspectLocalCore / ensureLocalCore
  src/core-manager.test.ts
  src/index.ts

packages/server/src/
  service-idle.ts             persistent/on-demand 空闲判定
  service-idle.test.ts
  index.ts                    客户端计数接入空闲判定与 drain

scripts/launch.ts             Web/TUI 调用 ensureLocalCore
packages/desktop/src/main.ts  窗口前调用 ensureLocalCore
README.md                     更新本机使用方式和包职责
```

第一版不增加 runtime dependency，不修改 contract，不新增 Core 选择 UI，也不提供强制杀进程命令。
显式停止可继续用进程信号；以后若需要 `cinba core stop`，应增加受 loopback 与随机 token 保护的
graceful control endpoint，而不是在 Windows 上依赖强杀 PID。

## 7. 提交与验证顺序

每项仓库改动单独提交：

1. `docs(core-manager): design shared local Core lifecycle`
2. `feat(core-client): add Core health probe`
3. `feat(core-manager): add local Core process manager`
4. `feat(server): stop on-demand Core when safely idle`
5. `feat(core-manager): wire native client launchers`
6. `docs(core-manager): document shared local Core usage`

分项先运行对应 typecheck 与单元测试。全部完成后运行 `npm run check`；只有完整检查通过才允许 push。

## 8. 验收

- Core 未运行时，从任意 Windows 目录执行 `cinba` 能自动启动 Core 并进入 TUI。
- Core 已运行时，再开 Web、Desktop 或另一个 TUI，复用同一 PID。
- 两个客户端同时启动，只产生一个 Core。
- 关闭一个客户端而另一个仍连接时，Core 不退出。
- 最后一个客户端退出后，宽限期内重连会取消退出。
- 零客户端但正在回复或等待确认时不退出；安全后才退出。
- `persistent` 模式在零客户端下永不自动退出，保护 VPS systemd 现有行为。
- `CINBA_SERVER` 指向远程地址时，TUI 不启动本机 Core。
- `npm run check` 全绿。
