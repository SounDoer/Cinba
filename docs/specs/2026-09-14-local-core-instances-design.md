# 本机 Stable 与 Dev Core 共存设计

日期：2026-09-14

状态：已实施并通过 macOS 双 Core 实测与完整仓库检查

## 1. 背景

开发电脑既要运行一个供日常使用的稳定 Core，也要运行跟随当前工作区代码的开发 Core。现有
`npm start`、TUI、Desktop 与系统托盘共同使用 `127.0.0.1:4517` 上的本机 Core；
`npm run dev` 也使用同一端口和同一套 `~/.cinba`、`~/.pi` 数据，因此启动前必须先停止普通
Core，也不能安全地同时运行两套代码。

Mac mini 后续需要让稳定 Core 常驻并通过 Tailscale 访问。如果开发模式仍与它争用端口和数据，
每次开发都会中断远程入口，并可能让未完成的代码改动接触真实会话和凭据。

## 2. 目标形状

```text
Stable Core
├── 127.0.0.1:4517
├── ~/.cinba
├── ~/.pi/agent
├── 普通客户端与未来的常驻服务使用
└── 可以由同机 Caddy 暴露给 Tailscale

Dev Core
├── 127.0.0.1:4518
├── ~/.cinba/dev
├── ~/.cinba/dev/pi-agent
├── npm run dev 启停
└── 只在 loopback 上供 127.0.0.1:5173 的 Vite 页面使用
```

这里的 instance 是一个完整运行实例：端口、Cinba 状态、Pi 凭据与会话必须一起隔离。只改端口
仍会让两个 Pi 进程同时读写同一份数据，不构成安全共存。

第一版不增加需要用户学习的新产品命令。`cinba`、`npm start`、Desktop 和托盘自然使用 Stable；
`npm run dev` 自然使用 Dev。

## 3. 配置边界

Server 新增一个明确的 Cinba 状态目录输入。未提供时继续使用 `~/.cinba`，因此现有本机和 VPS
行为不变。Pi 已提供 `PI_CODING_AGENT_DIR`，开发启动器直接把它指向 Dev 专用目录，不改写整个
进程的 `HOME`。

```text
Stable（默认）
CINBA_PORT=4517
CINBA 状态目录=~/.cinba
PI_CODING_AGENT_DIR=~/.pi/agent

Dev（由 npm run dev 提供）
CINBA_PORT=4518
CINBA 状态目录=~/.cinba/dev
PI_CODING_AGENT_DIR=~/.cinba/dev/pi-agent
```

开发 Core 第一次使用时没有 Stable 的 Provider 凭据和会话，需要单独配置。不能用符号链接或
复制后持续同步 `auth.json` 来绕过隔离。

`npm run dev` 同时把 Vite 的 `/ws` 代理指向 4518。Vite 仍监听 `127.0.0.1:5173`；Server 仍硬性
监听 `127.0.0.1`，任何 instance 配置都不能把它改成 `0.0.0.0`。

## 4. 生命周期与程序版本

Stable 当前继续沿用本机 core-manager 的 on-demand 生命周期。后续 macOS 常驻部署阶段再由
`launchd` 以 persistent 模式运行经过验证的版本；本设计只先解决两个 Core 的并存和数据隔离，
不提前混入常驻服务安装。

Dev Core 由前台开发启动器持有。它的 server 生命周期使用 persistent，避免 Vite 页面短暂刷新时
触发空闲退出；按 Ctrl+C 后启动器向 Core 和 Vite 发送 SIGTERM 并一同结束。

## 5. 跨平台规则

实例隔离规则适用于 Windows、macOS 和 Linux。平台差异只存在于将来如何托管 Stable Core：

```text
Windows → 托盘、登录启动项或后续选定的服务机制
macOS   → launchd
Linux   → systemd
```

开发启动器还要使用各平台原生的浏览器打开命令：Windows 使用系统 URL handler，macOS 使用
`open`，Linux 使用 `xdg-open`。这不是 instance 的数据规则，但它是 Mac 上真实运行
`npm run dev` 的必要条件。

## 6. VPS 兼容性

VPS 只有一个 Stable Core，继续由 systemd 从 `prod` release 启动。它不运行 `npm run dev`，也不
设置新的状态目录输入，所以继续读取：

```text
/home/cinba/.cinba
/home/cinba/.pi/agent
```

端口、Caddy、Tailscale、部署状态、凭据和会话路径均不改变。改动先进入 `master`；只有完整检查
通过并由用户明确执行 promote 后才进入 `prod`，因此开发过程不会直接更新 VPS。

## 7. 验证

- 默认 Server 没有新环境变量时仍使用 `~/.cinba` 和 4517。
- core-manager 启动的普通 Core 明确使用 Stable 路径，不继承偶然的 Dev 环境。
- `npm run dev` 使用 4518、Dev Cinba 状态目录和 Dev Pi agent 目录。
- Vite `/ws` 代理与 Dev Core 使用同一端口。
- 4517 已有健康 Core 时，`npm run dev` 仍可启动。
- Stable 与 Dev 分别创建配置和会话，不读取对方数据。
- Windows、macOS 和 Linux 的浏览器打开命令由单元测试覆盖。
- `npm run check` 完整通过。

## 8. 实施结果

Mac 上使用临时数据完成了真实双 Core 验收：Stable Core 在 4517、Dev Core 在 4518、Vite 在
5173 同时运行并返回健康状态。分别连接两个 Core 并创建会话后，Stable 与 Dev 各自在自己的
目录生成 `config.json`、Pi `auth.json` 和 sessions，没有交叉写入。

随后通过真实 `npm start` 验证 Stable Core 能由 core-manager 在后台启动、通过健康检查并由受保护
的本机控制入口有序停止。所有现场数据均位于临时目录，验收结束后已清理，没有读取或修改用户的
真实 `~/.cinba` 与 `~/.pi`。

最终 `npm run check` 通过：格式、lint、全部 TypeScript 检查、323 个单元测试（321 通过、2 个
Windows-only 测试在 macOS 跳过）、5 个 E2E 和 Web production build 均成功。
