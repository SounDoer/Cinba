# 形态 C 第 3 步：VPS + Tailscale 远程接入设计

日期：2026-09-12
状态：实现中；本地部署机制已完成，VPS 现状、系统配置与首次部署仍待实操核对
前置：本机 Core + Web + TUI、多会话、模型切换、凭据管理、权限确认、消息编辑、
Core 身份、正式／开发启动器与质量检查基线均已完成并完成人工回归

## 1. 本阶段要得到什么

在现有本机 Core 之外，在 VPS 上运行第二个独立 Core，让自己的受信设备通过 Tailscale
访问它，从而在手机或外部电脑上管理 VPS 上的项目。

```text
本机 Web / Desktop / TUI → 本机 Core → 本机项目

手机 / 外部电脑          → VPS Core  → VPS 项目
```

两个 Core 使用同一套 Cinba 代码，但会话、配置、凭据、费用统计和项目目录完全独立。
第一版不在两个 Core 之间同步任何状态，也不让 VPS Core 操作家里电脑。

## 2. 已确认的总体架构

```text
手机或外部电脑上的浏览器
            │
            │ HTTPS + WSS
            ▼
Tailscale 私有网络 + Grant
            │
            ▼
Caddy（只在 VPS 的 Tailscale 地址上接收 443）
            │
            │ HTTP + WebSocket，仅 VPS 内部
            ▼
Cinba server（仍只监听 127.0.0.1:4517）
            │
            ▼
agent → Pi → VPS 上的项目与命令
```

三者的职责：

- **Tailscale** 是私人道路和设备／用户门禁。
- **Caddy** 是 HTTPS 接待层，负责证书、TLS 和反向代理。
- **Cinba** 是真正处理会话、模型、工具和权限确认的应用。

## 3. 为什么现在就引入 HTTPS 与 Caddy

后续移动端已经明确会考虑 PWA、浏览器通知、摄像头等浏览器能力。这些能力通常要求
secure context，因此 HTTPS 是后续能力的基础，不应先上线 HTTP 再重做入口。

VPS 上很可能已经安装并运行 Caddy。实操时先检查现有版本、服务状态、Caddyfile、站点、
端口和 Tailscale 证书权限，只新增一个 Cinba 站点，绝不覆盖既有应用配置。

Caddy 原生支持 WebSocket 反向代理，也能直接从本机 Tailscale 获取并自动续期
`*.ts.net` 证书：

- <https://caddyserver.com/docs/caddyfile/directives/reverse_proxy>
- <https://tailscale.com/docs/integrations/web-servers/caddy/caddy-certificates>

第一版不用 `tailscale serve` 的七层 HTTPS 反向代理。调研时发现其当前存在尚未关闭的
WebSocket 握手与稳定性问题：

- <https://github.com/tailscale/tailscale/issues/20882>
- <https://github.com/tailscale/tailscale/issues/18827>

## 4. `CINBA_HOST` 决定更新：第一版不增加

原计划是增加严格校验的 `CINBA_HOST`，让 Cinba 直接监听 VPS 的 Tailscale IP。
引入 Caddy 后不再需要这样做：

```text
Caddy       → 监听 Tailscale IP:443
Cinba       → 继续监听 127.0.0.1:4517
```

这保留了现有最强的监听约束：Cinba 永远不直接面对任何外部网卡。网络开放和 TLS 都收口在
专门做这件事的 Caddy 与 Tailscale 上。因此 3b-2 不新增 `CINBA_HOST`，除非实操发现 Caddy
方案存在无法接受的限制。

## 5. 地址、证书与公网边界

VPS 通过 MagicDNS 获得类似下面的完整名称：

```text
cinba-vps.example-tail.ts.net
```

用户从受信设备访问：

```text
https://cinba-vps.example-tail.ts.net
```

Caddy 的 Cinba 站点必须明确 `bind` 到 VPS 的 Tailscale IP，而不是默认监听所有接口：

```caddyfile
cinba-vps.example-tail.ts.net {
    bind 100.80.12.34
    reverse_proxy 127.0.0.1:4517
}
```

上面只表达设计形状，实操时以真实域名、IP 和既有 Caddy 配置为准。修改后必须用
`caddy adapt`、配置校验和实际监听端口检查确认结果，不能只凭 Caddyfile 表面判断。

安全约束：

- VPS 公网防火墙不为 Cinba 新开端口。
- Cinba 自己仍只监听 loopback。
- Caddy 的 Cinba HTTPS listener 只绑定 Tailscale IP。
- Tailscale Grant 只允许指定身份访问 VPS 的 `tcp:443`。
- 现有公网 Caddy 站点继续独立工作，按域名和 listener 分流。

启用 Tailscale HTTPS 后，完整机器域名会出现在公开的证书透明度日志中。机器名应使用
`cinba-vps` 这类不含姓名、公司或其他隐私信息的普通名称。域名可见不等于服务可达；网络访问
仍由 Tailscale 控制。

## 6. Tailscale 负责认证，Cinba 不自造登录

Tailscale 当前推荐使用 Grants，而不是新建旧式 ACL：

<https://tailscale.com/docs/features/access-control/grants>

Grant 表达的规则是：

```text
指定的 Tailscale 用户／设备
→ 可以访问 VPS
→ 仅 tcp:443
```

本阶段不实现 Cinba 用户名、密码、应用令牌或扫码配对。若不同家庭成员需要不同访问权，
必须使用不同的 Tailscale 身份；共用同一个 Tailscale 账号无法按人区分。

SSH 只作为 VPS 管理通道，用于首次安装和故障处理，不是 Cinba 网页的登录系统。日常发布不要求
人工 SSH。

## 7. 已确认：本机与远程功能完全一致

只要一个客户端通过 Tailscale Grant 获准进入某个 Core，它就拥有这个 Core 的完整 Cinba 功能：

- 发消息、编辑消息；
- 查看、新建、切换、重命名和删除会话；
- 列出和切换模型；
- 添加、替换和删除 API key；
- 允许或拒绝工具调用。

不再按“本机／远程”制造功能差异。当前 server 中依据 loopback 拒绝远程凭据修改的逻辑需要在
本阶段移除，也不增加 `canManageCredentials` 之类的前端能力开关。

理由是：获准使用远程 Cinba 的人本来就能发消息、批准工具并操作 VPS shell。单独禁止凭据管理
不能构成真正的安全边界，只会增加产品分叉和虚假的安全感。安全边界应放在 Tailscale Grant、
Caddy 精确监听、操作系统用户隔离与统一权限门上。

## 8. WebSocket Origin 校验

Tailscale 能判断设备是否获准访问，但不能判断设备上的连接来自真正的 Cinba 页面，还是用户刚好
打开的恶意网页。浏览器会在 WebSocket 握手中发送 `Origin`，server 必须主动校验它。

原则：

```text
浏览器请求带 Origin
→ 只接受 Cinba 自己的本机或 HTTPS Origin

TUI 等非浏览器客户端不带 Origin
→ 不因缺少 Origin 被误伤
```

Origin 校验防的是浏览器中的跨站 WebSocket 攻击，不宣称能防住已经控制整台受信设备的恶意程序。
具体允许规则要覆盖生产 HTTPS、本机正式模式和 Vite 开发模式，并添加相应测试。

## 9. 断线、权限确认与恢复

### 9.1 权限确认

任何工具调用都必须遵守：没有明确收到 Allow，就不得执行。

当前 server 已在最后一个查看该会话的客户端断开时拒绝待确认操作。本阶段再给 Pi 的
`confirm()` 增加 **10 分钟超时**，处理网络已经失效但 WebSocket 尚未及时报告断开的情况。

```text
明确 Allow → 执行
明确 Deny  → 拒绝
客户端断开 → 拒绝
等待 10 分钟仍无回答 → 拒绝
```

这套规则本机和远程完全相同。

自动部署请求旧 Core 停止时，旧 Core 先进入 **draining**：停止接受新的 prompt、模型切换和
新会话等工作，但继续完成已经运行的回复，并允许回答或中止已经存在的权限确认。排空最长等待
**15 分钟**；到期后有序拒绝剩余确认、中止未结束任务、关闭 Pi 并退出，不能依赖粗暴的
`kill -9`。10 分钟确认超时与 15 分钟排空上限共同保证更新最终能够继续。

### 9.2 Web 自动重连

当前 `CoreClient` 断线后只进入 `disconnected`，Web 页面不会自动重连。本功能已拆到独立 session
先行实现，要求：

- 初次失败和中途断开都自动重试；
- 使用有上限的退避；
- 成功后重置退避；
- 组件卸载后彻底停止；
- 任一时刻最多一个 socket 和一个 timer；
- **只重连，绝不缓存或重放断线前的命令**；
- 重连后以 server 新发的完整 snapshot 为唯一真相。

TUI 仍维持断线后退出，自动重连继续按主设计文档暂缓。

## 10. 多 Core 的第一版使用方式

第一版不做 Core 切换器。浏览器用两个书签：

```text
Cinba · Local → http://127.0.0.1:4517
Cinba · VPS   → https://cinba-vps.example-tail.ts.net
```

现有 Core 身份名称和颜色继续常驻显示，防止在错误机器上执行命令。手机与电脑可以同时连接
VPS Core；看同一会话时共享更新和权限确认，谁先回答确认谁生效。

外部设备必须安装、登录 Tailscale 并满足 Grant。第一版不支持在网吧、借来的电脑等未加入
tailnet 的设备上只凭网址访问。

## 11. VPS 用户与数据边界

Cinba 使用独立的普通 Linux 用户运行，例如 `cinba`，绝不使用 root。它不是 VPS 厂商的新账号，
而是现有 Linux 系统中的服务用户。

建议目录形状：

```text
/home/cinba/Cinba       Git clone 得到的仓库，用于跟踪远端
/home/cinba/releases    各个已经安装、构建和验证的发布版本
/home/cinba/current     指向当前运行版本的符号链接
/home/cinba/.cinba      Cinba 运行配置
/home/cinba/.pi         Pi 的凭据与会话
```

其中：

- `.cinba/config.json` 保存 cwd、默认模型、最后会话和 Core 名称；
- `.pi/agent/auth.json` 由 Pi 保存模型凭据；
- `.pi/agent/sessions/` 由 Pi 保存会话历史；
- 自动部署只替换程序版本，永不覆盖 `.cinba`、`.pi` 或用户项目。

项目目录不在本阶段强制规定。实操时查看 VPS 现有布局后再决定是否统一使用
`/home/cinba/projects`。

运行数据备份暂缓。触发信号是 VPS 上已经积累了不愿丢失的会话或重要配置；届时另做加密备份
设计，不把凭据或会话提交到 GitHub。

## 12. systemd 服务

VPS 上三个服务各自负责自己的生命周期：

```text
tailscaled.service → 私有网络
caddy.service      → HTTPS 与反向代理
cinba.service      → Cinba Core
```

Cinba 由 systemd 自动启动、异常退出后自动重试，并以普通 `cinba` 用户运行。Tailscale 或
Caddy 暂时未就绪时，不得导致永久启动失败；具体依赖和重试方式等查看 VPS 发行版及既有 unit 后
再定。

采用 systemd **user service**，而不是让部署任务以 root 运行：

```text
/home/cinba/.config/systemd/user/cinba.service
/home/cinba/.config/systemd/user/cinba-update.service
/home/cinba/.config/systemd/user/cinba-update.timer
```

首次安装时由管理员执行 `loginctl enable-linger cinba`，让该用户没有登录时也能开机运行服务。
`cinba-update.service` 只能修改 `/home/cinba` 下的仓库、release 与符号链接，并重启同一用户的
`cinba.service`；它不持有 sudo 权限，不能修改 Caddy、Tailscale、`/etc` 或其他系统服务。

### 12.1 管理整台 VPS 的受控提权

普通用户是 Cinba 的默认权限，不代表永远不能帮助管理系统。真正需要 root 的动作使用三层约束：

```text
Permission Gate 人工确认
→ sudoers 的操作系统硬边界
→ root 拥有、cinba 用户不能修改的受限管理入口
```

命令使用 `sudo -n`，未获授权时立即失败，不能在后台等待密码。`/etc/sudoers.d/cinba` 只授权
实际出现的管理动作，不授予 `NOPASSWD: ALL`，也不让自动部署器继承这些能力。普通项目工作由
`cinba` 用户直接完成；常见系统管理逐项加入受限入口；未预料到的高风险管理仍由管理员处理。

## 13. Git 分支与自动部署

已确认分支语义：

```text
master → 开发主线
prod → VPS 应当运行的版本
```

`prod` 不直接开发、不产生独立提交，只快进到已经验证过的 `master` commit。VPS 只监控
`origin/prod`，因此普通 `master` push 不会打断正在使用的 VPS。

本地发布命令 `npm run promote` 已实现：

```text
确认当前在 master
→ 工作区干净
→ master 与 origin/master 同步
→ npm run check 全绿
→ git push origin master:prod
```

脚本还会在质量检查后再次确认工作区仍然干净、`HEAD` 没有变化，然后用非强制 push 推进
`prod`。它现在只负责安全地更新部署分支，不会自行连接或轮询 VPS。

真正跑通一次发布后，可再用 Skill 包装为“展示差异 → 检查 → 用户确认 → 推进 prod → 等待部署
→ 验证线上版本”的完整流程。底层确定性动作继续保留为仓库脚本，Skill 只负责编排和汇报。

仓库已于 2026-09-13 完成当前文件、完整 Git 历史和提交身份审计，并在补齐 README、项目元数据
与 MIT License 后切换为 public。因此 VPS 读取 GitHub 不需要 token 或 deploy key。审计记录见
`docs/notes/2026-09-13-public-repository-audit.md`。

## 14. 自动部署模型

采用 VPS 主动拉取，不让 GitHub 主动登录 VPS，也不为 webhook 开公网入口：

```text
systemd timer 定期检查 origin/prod
→ 没变化：安静退出
→ 有新 commit：在独立 release 目录准备新版本
→ npm ci
→ 质量检查与 build
→ 等待当前 Core 可安全停止
→ 切换 current
→ 重启 cinba.service
→ 健康检查
→ 成功则保留新版本；失败则回退旧版本
```

不能在当前运行目录里直接 `git pull && restart`。新版本必须先在旁边准备和验证，失败时当前版本
继续运行。timer 每 60 秒检查一次 `origin/prod`；没有变化时立即退出。总共只保留最近 **2 个成功
发布版本**（当前版本和上一个版本），新版本确认成功后清理更早的 release。失败且从未成功运行的
release 在记录错误后删除；清理前必须解析并保护 `current` 的真实目标，不能依赖未经校验的路径。

自动部署不得在模型回复或权限确认中途强制切断 Core。已准备好的版本应等待安全窗口，再进入
停止／切换／启动流程。旧 Core 收到停止请求后进入第 9 节定义的 draining，以“停止接新任务、
服务完已有任务”的方式封闭仅查询 `safeToRestart` 与真正停止之间的竞态。

部署任务使用 `flock` 保证任意时刻只有一个实例能修改 release 与 `current`。准备阶段发现
`prod` 已出现更新时可以放弃尚未切换的旧目标并追到最新 commit；一旦进入切换阶段，就必须把
当前目标的成功或回滚流程完整走完。旧目标会记为 `superseded`，不会被误记为失败或隔离。
timer 在锁被占用时以专用退出码 `75` 安静退出，下一分钟重新检查。

失败的目标 commit 记录为 `failedRevision`。只要 `origin/prod` 仍指向同一个失败 commit，timer
就不重复部署；等待 `prod` 出现新的修复或 revert commit。Git 历史不通过强推回退：运行状态可
立即切回上一成功版本，仓库则在 `master` 上用新修复或 `git revert` 继续向前，再推进 `prod`。

### 14.1 已落地的状态机与故障恢复

部署器把每次尝试原子写入 `/home/cinba/.cinba/deployment.json`，只记录可公开的 revision、阶段和
精简失败类别，不记录命令输出、路径、凭据或会话内容。已实现的阶段为：

```text
idle
→ preparing
→ checking
→ waiting_for_drain
→ switching
→ verifying
→ succeeded

checking → superseded
任一工作阶段 → failed
switching / verifying → rolled_back
```

精简失败类别为 `fetch`、`checkout`、`install`、`checks`、`drain`、`switch`、`start`、`health`、
`rollback` 和 `cleanup`。完整错误只进入部署进程日志。

部署进程意外退出后，下次运行不会盲目重做。它会把持久化阶段与 `current` 符号链接的真实目标进行
核对：

- 中断发生在准备、检查或等待排空阶段，且 `current` 未变：丢弃未启用的候选版本并记录失败；
- 中断发生在切换或验证阶段，且 `current` 已指向候选版本：继续启动并验证，失败则恢复上一版本；
- `current` 仍指向旧版本：验证旧服务可用，再把这次尝试收束为失败或已回滚；
- `current` 指向预期之外的版本：停止猜测，记录 `rollback` 失败，等待人工检查。

第一次部署没有上一版本可回退。若新 Core 启动或健康检查失败，部署器只移除自己刚设置的
`current`，结果记为 `failed`，不会把“什么都没恢复”称为 `rolled_back`。

成功后只保留当前与上一个成功 release。失败候选不会覆盖较早的成功后备版本；清理前还会再次
确认 `current` 与状态中的运行 revision 完全一致，并忽略形状可疑的目录。

### 14.2 已落地的代码职责

自动部署代码集中在 `packages/deploy`：

```text
deployment-config / release-layout   固定目录与路径边界
status / status-file / transitions   状态格式、原子持久化与合法迁移
git-source / decision                拉取 prod、快进校验与是否部署
prepare-release                      独立 worktree、npm ci 与 npm run check
activate-release / switch-release    draining、停止服务与原子切换
verify / verify-activation           HTTP revision、WebSocket 与自动回退
recover-deployment                   中断后的状态核对与收束
release-cleanup                      只保留两个成功版本
deployment-lock / locked-deployment  flock 单实例入口
run-deployment / deployment-cli      完整流程编排与命令行入口
```

这些模块已经通过本地单元测试和仓库完整质量检查，但尚未替代真实 VPS 验证。systemd unit、Caddy
站点和 Tailscale Grant 仍必须根据机器现状生成并现场验证。

## 15. 健康与版本接口

Cinba server 已新增：

```text
GET /healthz
```

建议响应：

```json
{
  "status": "ok",
  "revision": "def4567",
  "safeToRestart": true
}
```

部署状态还需提供不含敏感信息的目标 revision、阶段与精简结果，让 `npm run promote` 和未来的
Release Skill 能区分“尚未发现”“正在构建”“等待 draining”“成功”“已回滚”和“失败”。完整
命令输出只进入本机日志，不通过健康接口返回。

用途：

- timer 判断是否处于安全更新窗口；
- 部署后确认 HTTP 与目标 revision 正常；
- 再补一次 WebSocket 建连检查；
- 将来的 Release Skill 验证 VPS 是否已运行 `prod` 目标 commit。

接口不返回会话、API key、项目路径等敏感内容。

建议文件职责：

```text
packages/server/src/health.ts       状态响应
packages/server/src/health.test.ts  纯函数与 HTTP 行为测试
packages/server/src/index.ts        接线与提供运行状态
packages/server/src/static-files.ts 继续只负责静态资源
packages/server/src/server-runtime.ts 继续只负责 HTTP / WebSocket 生命周期
```

revision 如何从 release 注入、`safeToRestart` 的严格定义、draining 的具体消息与回滚健康检查
已经在代码与测试中落地。生产入口 `packages/server/src/service-entry.ts` 会从当前 release 读取完整
Git `HEAD`，校验为 40 位 commit 后再设置 `CINBA_REVISION`，避免部署器验证到模糊或伪造的版本。

部署状态也已通过 `GET /deployment-status` 提供。`@cinba/server` 依赖 `@cinba/deploy` 并直接复用
同一份严格解析器：有效状态返回 `200`，尚无状态文件返回 `404 not_configured`，文件无法读取或
内容损坏返回 `503 invalid`。错误详情不会进入响应。这个接口主要服务于后续 Promote Skill 的远程
进度汇报；`/healthz` 仍只负责 Core 自身的存活、版本和是否可安全重启。

## 16. 本阶段不做

- 不把 Cinba 暴露到公网；
- 不做应用令牌、Cinba 登录或多用户系统；
- 不做本机与 VPS 的会话同步；
- 不做外出访问家里 Core；
- 不做 Core 切换器；
- 不做 TUI 自动重连；
- 不做运行数据备份；
- 不在 3b-2 内完成手机响应式布局、PWA、通知或摄像头功能。

最后一条不是取消这些能力。3b-2 现在建立 HTTPS，是为了让后续第 4 步可以在正确的基础上实现
移动端与浏览器高级能力。

## 17. 剩余工作与实操前确认

1. VPS 的 Linux 发行版、Node.js、Git、Tailscale 与 Caddy 版本。
2. 现有 Linux 用户、Caddyfile、站点、listener 和防火墙布局。
3. Caddy 是否已有读取 Tailscale 证书的权限；若没有，按官方方式配置
   `TS_PERMIT_CERT_UID=caddy`。
4. VPS 的 Tailscale IP、MagicDNS 完整域名，以及机器名是否适合进入公开证书日志。
5. tailnet 现有 Grants／ACL，避免新增规则与旧的宽泛规则叠加后意外放大权限。
6. 在真实远程 HTTPS 入口复核 Origin 校验；本机正式模式、Vite 开发模式和无 Origin 客户端已有
   自动测试。
7. 编写并安装匹配真实 VPS 的 systemd user units，完成首次 bootstrap 与异常重启验证。
8. 用真实 Caddy、Tailscale、HTTP、WebSocket、部署状态接口和自动回滚完成端到端部署演练。

以上实操信息没有核实前，不编造 Caddyfile、systemd unit 或 Tailscale Grant 的最终内容。
