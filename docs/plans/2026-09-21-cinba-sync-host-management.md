# Cinba Sync Host 管理实施计划

日期：2026-09-21

状态：阶段 0—5 已完成；阶段 6 已完成只读盘点和候选上传，等待 `cinba` 用户操作权限

对应规格：`docs/specs/2026-09-17-cinba-sync-product-experience.md`

## 目标

把已经包含在 Windows、macOS、Linux 正式安装包中的 Sync Server，变成普通用户可以从同一套
Cinba 产品入口创建、配置、运行和删除的本机 Sync Host，并首先在 Linux VPS 上完成真实安装验收。

第一切片完成后，用户应当能够：

- 安装一个正式 Cinba artifact，不需要 Git、npm、系统 Node 或源码 checkout；
- 使用 CLI 或 TUI 在本机创建 Sync Host；
- 保持 Sync 只监听 loopback，并单独配置用户已有 HTTPS 入口的 `publicOrigin`；
- 用当前 Core 的有效 Settings 初始化 Shared Settings，但不上传 API Credentials；
- 自动连接并只批准这次创建流程所发起的当前 Core enrollment；
- 在 `disabled / on-demand / background` 之间切换；
- 查看 Host、服务、首次管理设置和当前 Core 的状态；
- 普通卸载后保留 Host，只有明确的 Host Delete 或产品 purge 才永久删除 authority；
- 在 VPS 重启后恢复 Background Core 与 Sync，并通过用户已有的 HTTPS 入口管理。

这份计划不实施 Tailscale、Caddy、Nginx、DNS、TLS、防火墙、无密码管理端、Desktop 图形入口或新的
自动更新机制。

## 2026-09-21 实施进度

- Host 配置、受保护 bootstrap、跨平台 manager、正式 CLI 和 TUI 管理入口已经实施；CLI 与 TUI
  共用 `installed-sync-host` manager，不再保留两套创建/删除编排；
- 真实 Core + Sync 子进程已经覆盖 `create → bootstrap → configure → status → delete`，Windows
  payload 也已实际执行包内 `version/help/sync status`、Core 与 Web 烟测；
- `npm run check` 通过：1109 个单元测试中 1106 通过、3 个按平台跳过，12 个 E2E 全部通过，三端
  Web 构建通过；
- Linux Headless candidate 已在干净 Node 24 容器中构建，bundle 自检完成隔离安装与启动；revision 为
  `8a0201b1d23a2cebad4870a2efc51d0266ca260c`，artifact SHA-256 为
  `7b6797ea4472cae8aee6cc107d37723d00d16aeb3cf3b94c06392fbd695e0e38`；
- 同一 artifact 已在第二个干净 Linux 容器中执行包内 `version`、`help` 和
  `sync status --json`，并上传到 VPS 的 `/home/xichen/cinba-staging-8a0201b1/`；远端重算 digest 一致，
  尚未安装；
- VPS 只读盘点确认：`cinba` 用户 linger 已启用；旧 Core/Sync 仍从 `/home/cinba/current` 源码链运行，
  且只监听 `127.0.0.1:4517/4518`；Caddy 与 Tailscale active，必须保留；
- 当前 SSH key 只能登录 `xichen`，不能登录 `cinba`，且 `xichen` 没有免密 sudo。阶段 6 的旧数据
  inventory、服务停止、隔离移动和正式安装必须等用户提供一次 `cinba` 登录或等价的受限提权入口，
  不能绕过该权限边界。

## 已确认的技术事实

- 正式 payload 已经包含 Core、TUI、Sync Server、sync-web、私有 Node、Pi 和后台服务 adapter；本次
  不新增第四种安装包，也不建立独立的 Sync 安装器。
- `@cinba/product-runtime` 已经统一管理 Core/Sync 生命周期，稳定 launcher 已能运行
  `cinba service sync`；缺口是“Host 是否创建”的可靠状态、持久配置和完整编排。
- Core 与 Sync 已分别拥有 token 保护的 loopback-only 本机控制面。它们适合承载产品管理器专用的
  bootstrap 操作，普通 Web/TUI API 不应接触 enrollment secret 或 Sync authority 内部文件。
- Sync authority 第一次启动会生成 Setup Code；现有 sync-web 已能完成
  `Setup Code → 管理员密码 → 管理会话`，第一切片直接复用。
- `publicOrigin` 当前由启动环境变量传入，正式服务进程仍硬编码为 loopback HTTP；需要改为从严格解析的
  Host 配置生成环境，但监听地址继续固定为 `127.0.0.1`。
- 当前用 Sync 数据目录是否存在来判断 `componentCreated`，这会把半成品或失败残留误判成已创建 Host；
  新实现必须以提交后的 Host 配置为准。

## 关键设计决定

### 1. 单一 Host 管理核心

`@cinba/product-runtime` 拥有跨平台 Host 配置、锁、创建事务、状态聚合、生命周期和删除编排。
CLI 直接调用它；TUI 只调用同一公开 API，不读写配置文件、不操作 systemd，也不复制状态机。

平台 adapter 仍只负责 Scheduled Task、LaunchAgent 和 systemd user service。Sync Server 只负责
authority 和受保护的本地 bootstrap 原语，不反向管理安装或平台服务。

### 2. 配置、authority 与运行状态分离

沿用 installer 给出的路径，但明确三种所有权：

```text
Config/sync.json             # Host 配置；是否存在且有效是 Host 已创建的提交点
Data/Sync/                   # Sync authority、加密 key、设置、凭据、历史与管理状态
State/                       # 锁、服务 control record、短期创建事务和运行状态
```

`sync.json` 使用严格 v1 schema，只接受：

```json
{
  "schemaVersion": 1,
  "publicOrigin": "https://sync.example.com"
}
```

本机-only 默认值是精确的 `http://127.0.0.1:4518`。其他 HTTP origin、userinfo、非根路径、query、
fragment 和非标准化 origin 一律拒绝。远程 origin 必须是 HTTPS。写入使用私有权限、同目录临时文件、
flush 后原子替换；未知 schema 或额外字段 fail closed。

### 3. 创建是可恢复事务，不以“目录出现”代表成功

`create` 在产品管理锁内执行，并记录阶段化事务：

```text
validate → stage config → start Core/Sync → bootstrap → wait Core online
         → commit config → apply requested mode → clear transaction
```

正式配置只在 bootstrap 成功后提交。失败时取消本次 Core enrollment、停止本次启动的临时进程并删除
本次新建但未提交的 authority；不得碰到创建前已经存在的 Core 数据、本地 Settings 或 Credentials。
进程崩溃后，下次 `create/status/delete` 先恢复或回滚未完成事务，不能把残留目录报告为健康 Host。

已经存在有效 Host 时，`create` 幂等返回状态；配置损坏、authority 缺失或相反的孤儿 authority
进入明确的 `repair-required`，不自动覆盖或静默重建信任根。

### 4. 本机自动 enrollment 使用双控制面和一次性证明

自动批准不能扫描并批准“看起来像本机”的 pending request，也不能把所有同机 Core 设为可信。
流程固定为：

1. 产品管理器使用 Core 的本机 control token，请求当前 Core 发起 enrollment；
2. Core 返回仅给产品管理器的 `enrollmentId`、`enrollmentSecret`、过期时间和当前有效 Settings；
3. 产品管理器立即用 Sync 的本机 control token 调用一次 bootstrap；
4. Sync 校验 id + secret 精确对应仍有效的 pending enrollment，在一次 store transaction 中写入初始
   Shared Settings 并批准该 enrollment；
5. 产品管理器等待当前 Core 消费批准结果并达到 `online`，然后丢弃内存中的 secret。

这条本地协议只在 manager token 存在时注册，只接受 loopback 请求，响应使用 `no-store`，敏感值不写
日志、配置、事务文件或 CLI 输出。普通 `/api/sync/*` 和 sync-web 都不返回 enrollment secret。

### 5. 生命周期语义

- `disabled`：停止 Sync、撤销平台后台注册，保留配置和 authority；
- `on-demand`：不注册开机常驻服务，由本机产品表面需要 Host 时启动，最后一个本机产品使用者退出后按
  现有 idle/drain 规则停止；它不承诺为远程 Core 持续在线；
- `background`：注册当前用户平台服务并常驻；VPS 推荐此模式。

未创建 Host 时只允许 `create`、`status` 和前台诊断，不允许直接设置 `background`。`serve` 始终读取
同一 Host 配置；提供临时 public origin 的开发入口留在 Cinba Dev，不进入正式产品语义。

CLI `create` 默认提交为 `on-demand`；自动化或 VPS 通过随后的
`cinba sync mode background` 明确启用常驻。TUI 创建完成后立即让用户选择模式。

### 6. Delete 与整个产品卸载保持不同边界

`cinba sync delete` 是永久删除信任根的独立危险操作：先读取 Connected Core 数量，要求精确确认，
处理当前 Core 断开，再停止服务、移除 Host 配置和 authority。普通 `cinba uninstall` 继续保留配置和
authority；`cinba uninstall --purge` 继续删除整个 Cinba 数据范围。

第一切片尚未实现规格第 6.1 节完整的断开迁移 UI，因此若当前 Core 正在使用 Shared Settings，Delete
必须先把当前有效 Shared Settings 复制为 Local Settings；若正在使用 Shared Credentials，则拒绝自动
复制并要求用户先在现有 Core Sync 流程中明确处理。不能让 Delete 静默恢复很旧的本地设置或复制共享
API key。

## 实施阶段

## 阶段 0：固定 Host 模型与失败语义

### 改动

- 在 `packages/product-runtime/src/` 增加 Host config、status、transaction 和 manager 的无 UI 模块；
- 为 created/health/setup/lifecycle/repair 状态定义单一视图；
- 把正式端口和 loopback origin 从散落字符串收敛到已有产品路径/运行身份配置；
- 明确错误类别：`not-created`、`already-created`、`invalid-config`、`missing-authority`、
  `orphaned-authority`、`busy`、`bootstrap-failed`、`service-unavailable`。

### 测试

- 三个平台路径、默认 origin 和严格 URL 校验；
- 原子写入、未知 schema、额外字段、截断 JSON 和权限失败；
- 配置/authority 四种组合的状态；
- 同时 create/configure/delete 的锁与确定错误；
- 事务在每个阶段中断后的恢复。

### 建议提交

`feat(product-runtime): add sync host configuration`

## 阶段 1：增加受保护的本机 bootstrap 原语

### Core

- 扩展 `packages/server/src/local-core-control.ts`，增加 manager-only enrollment 操作；
- 复用现有 enrollment coordinator 发起请求，不绕过 Core connection store；
- 返回精确 enrollment receipt 和当前有效 Settings，不返回本地 API Credentials；
- 让 handler 支持异步操作，并保持 status/stop/lifetime 兼容。

### Sync

- 扩展 `packages/sync-server/src/local-sync-control.ts`，增加 manager-only bootstrap 与 Host status；
- 在 Sync store 增加原子的 `bootstrapLocalHost` 操作：校验 pending id/secret、初始 revision 和 setup 状态，
  一次提交 Shared Settings 与 approved Core；
- bootstrap 只能在未完成首次 Host bootstrap 时执行一次；重复相同请求可安全返回已完成，其他请求冲突；
- Host status 只返回 setup state、revision、Connected Core 数量等非敏感聚合，不返回 Setup Code、凭据或
  authority 内容。
- 增加独立的 manager-only Setup Code 读取操作，仅在 `setup-required` 时返回并带 `no-store`；它不进入
  普通 status、JSON 自动化输出或持久配置，完成管理员初始化后永久不可用。

### 产品管理客户端

- 扩展 `@cinba/core-client` 的本机 control client，承载 Core receipt 的严格解析；
- 扩展 product-runtime 已有 Sync control client，承载 bootstrap/status 严格解析；
- 不修改浏览器使用的 `CoreSyncView`，因此这一阶段不扩大 web、TUI、Desktop 的公共协议面。

### 测试

- token 缺失、错误 token、非 loopback/禁用控制面、错误 method 和超大 body；
- secret 错误、过期、已拒绝、并发 pending、重复 bootstrap；
- Shared Settings 被写入，Credentials 始终为空；
- 只批准指定 enrollment，其他 pending request 保持 pending；
- 敏感值不出现在日志、普通状态 API、错误响应或持久事务中。

### 建议提交

`feat(sync-server): add local host bootstrap`

## 阶段 2：实现跨平台 Host manager

### 改动

- 编排 Core 与 Sync 的临时 on-demand 启动、健康等待和双控制面 bootstrap；
- 将 Host 配置传入 `createProductServiceProcess`，替换正式 Sync 的硬编码 public origin；
- 继续强制 `CINBA_SYNC_HOST=127.0.0.1`，配置不能影响监听地址；
- 创建成功后默认 on-demand，显式 mode 切换继续复用现有 service manager；
- configure 只原子更新 origin，并以 drain-safe restart 让运行进程读取新配置；失败则恢复旧配置和运行模式；
- status 聚合 config、authority、服务模式、进程健康、setup state、管理地址和 repair 状态；
- delete 执行断开保护、停止、服务注销和范围精确的持久数据删除。

### 测试

- 从未创建到成功、重复 create、每个外部步骤失败和崩溃恢复；
- 创建前已运行/未运行 Core 的两种路径，结束后恢复合理生命周期；
- public origin 更新时 foreground/on-demand/background 的重启和回滚；
- 更新前后 Host 配置与 authority 不变，service 始终经稳定 launcher 指向 current release；
- normal uninstall 保留 Host，repair install 可重新识别，purge 删除；
- Delete 不越过 Cinba 的 config/data/state 范围，不删除用户网络配置或共享 linger。

### 建议提交

`feat(product-runtime): manage local sync hosts`

## 阶段 3：完成正式 CLI

### 命令

```text
cinba sync create [--public-origin URL]
cinba sync configure --public-origin URL
cinba sync status [--json]
cinba sync mode [disabled|on-demand|background]
cinba sync serve
cinba sync delete
```

### 行为

- 人类输出使用稳定、可执行的描述：created、availability、origin、mode、health、setup state 和下一步；
- `--json` 提供严格版本化输出，供 TUI 与自动化消费，不包含 secret 或 Setup Code；
- create 成功后，若仍需首次管理设置，只把 Setup Code 写到当前交互终端一次，并显示管理地址；
- 非 TTY create 可以成功，但 Setup Code 必须通过明确的 `--show-setup-code` 逃生口输出，不能混入 JSON；
- delete 需要 TTY 精确确认；无人值守使用专用危险确认参数，不能复用普通 `--force`；
- Linux 切到 background 时继续沿用已有 systemd/linger 诊断，不尝试 sudo 或自动启用 linger。

### 测试

- 参数组合、退出码、TTY/非 TTY、JSON schema、redaction；
- 未创建 Host 的 mode/configure/delete；
- 损坏配置、后台服务不可用、linger 缺失和 busy；
- foreground `serve` 收到 SIGINT/SIGTERM 后正确 drain。

### 建议提交

`feat(product-runtime): expose sync host commands`

## 阶段 4：在 TUI 中加入本机 Host 流程

### 改动

- 将现有 `/sync` 拆成 `This Core` 与 `Sync Host on this device` 两个清楚的区域；
- Host 区展示创建状态、origin、availability、mode、health、setup state 和可执行动作；
- create 使用当前 Settings、不共享 Credentials，并在确认页说明两者的差异；
- VPS 创建完成后引导选择 Background，并把 linger 需求解释为“退出 SSH 后继续运行”；
- configure 对 origin 变化展示重新登录/重新连接影响；
- disable 与 delete 分开，delete 展示 Connected Core 数量和不可恢复内容；
- 首次管理仍打开或展示现有 sync-web 地址，TUI 不复制 Shared Settings/Credentials 管理界面。

TUI 通过 product-runtime 公开 API 获取状态和执行动作；如果为了进程隔离调用稳定 launcher，则只消费
同一版本化 JSON 协议，不能解析人类文本。

### 测试

- 未创建、创建中、setup-required、healthy、disabled、offline、repair-required；
- 键盘取消、操作失败后返回、重复提交防护和危险确认；
- Host 操作不改变 `This Core` 已有连接流程，反之亦然；
- 窄终端和无颜色终端文案可读。

### 建议提交

`feat(tui): manage local sync hosts`

## 阶段 5：跨平台自动化与分发回归

### 自动化

- unit：config、transaction、manager、local control、CLI、TUI reducer/view；
- integration：真实 Core + Sync 子进程完成 create/bootstrap/status/configure/delete；
- packaging smoke：三个 payload 都能从稳定 launcher 执行 `sync status/create/serve`；
- service adapter：Windows/macOS/Linux 的 background 描述继续只引用稳定 launcher；
- update：运行中的 Host 跨 current release 切换后保持 config、authority、mode 和管理状态；
- uninstall：普通卸载保留、重装恢复、purge 删除；
- 安全：Sync 始终只监听 loopback，任何配置都不能改成 wildcard。

每个阶段至少运行相关 workspace 测试；合并前运行 `npm run check`。若改动公共 `packages/contract/`，必须
同步确认 Web、TUI、Desktop；当前计划优先通过受保护的本地 control client 避免扩大公共协议。

### 建议提交

`test(product-runtime): cover sync host lifecycle`

## 阶段 6：真实 VPS 清理、安装与验收

目标主机：`43.128.3.65`。仓库实现和 Linux artifact 通过后才执行本阶段；不能拿旧源码部署代替正式
artifact 验收。

### 清理前记录

- 记录旧 user units、timer、进程、端口、Caddy route、Tailscale 地址、linger 和磁盘占用；
- 先停止并禁用旧 `cinba-update.timer`，避免清理过程中旧自动任务重新写入；
- 对旧 `.cinba`、`.cinba-sync`、`.pi` 和必要日志生成只读 inventory；不把它们自动迁入正式产品；
- 将旧数据移动到带时间戳的隔离目录，而不是立即永久删除，待新部署验收和用户确认后再清除。

### 必须保留

- Linux 用户 `cinba`、home 权限与已经启用的 linger；
- Tailscale 安装、登录、ACL 与地址；
- Caddy 安装、证书和用户自有 route；
- 与 Cinba 无关的 systemd unit、SSH 配置、日志和数据。

### 移除旧部署链

- 停止并移除旧 `cinba.service`、`cinba-sync.service`、`cinba-update.service/timer`；
- daemon-reload 后确认旧 unit 不再存在；
- 移除旧 `/home/cinba/Cinba` checkout、`releases/`、`current` symlink、旧私有 Node 和旧部署脚本；
- 删除前逐项解析绝对路径并确认都位于 `/home/cinba` 的旧 Cinba 范围；不使用宽泛 glob 或递归 home
  删除。

### 正式安装与创建

1. 从已发布或候选 Linux artifact 校验 SHA-256 并执行当前用户安装；
2. 验证 `cinba version`、`doctor`、Core on-demand 与 payload inventory；
3. `cinba sync create --public-origin <用户现有 HTTPS origin>`；
4. 用 Setup Code 在 sync-web 设置管理员密码；
5. 将 Core 与 Sync 切换到 background，确认 systemd user units 指向稳定 launcher；
6. 验证当前 Core online、Shared Settings 已初始化、Shared Credentials 为空；
7. 通过 Caddy/Tailscale 远程访问管理页，确认 Host 仍只监听 `127.0.0.1:4518`；
8. 重启 VPS，确认 linger、Core、Sync、Caddy、Tailscale 和远程管理恢复；
9. 执行一次 disable/enable、configure no-op、普通 uninstall + reinstall 保留性探针；
10. 复核隔离数据后，再由用户明确决定是否永久删除旧数据备份。

### 失败回退

- 正式安装或 Host 创建失败时，保留日志、事务和隔离的旧数据，不启用旧 update timer；
- 产品代码问题回到仓库修复、自动化验证并重建 artifact，不在 VPS 手改 release 内容；
- 网络入口问题只调整或恢复用户自有 Caddy/Tailscale 配置，不把它写进 Cinba 安装器；
- 如果必须临时恢复旧服务，使用已记录的 unit 与隔离目录显式恢复，并标记此次正式验收失败。

### 建议记录

把命令、版本、revision、端口、重启结果、远程访问和发现的问题追加到：

`docs/notes/2026-09-18-cinba-product-distribution-verification.md`

## 完成标准

- Windows、macOS、Linux 的正式 payload 都提供相同 Host CLI 语义；
- TUI 能完成创建、配置、状态、模式、Disable 和 Delete，不要求 VPS 用户理解 systemd unit；
- 创建只自动批准当前流程的一个 Core，Settings 初始化正确，Credentials 没有上传；
- Sync 在所有配置下只监听 loopback，Cinba 没有安装或修改网络基础设施；
- update、普通 uninstall/reinstall 和 background 重启保持 Host authority；
- delete 与 purge 的永久删除范围都有测试和独立确认；
- `npm run check` 通过；
- 清理后的真实 VPS 从正式 Linux artifact 安装，重启后 Core + Sync + 用户 HTTPS 入口完整可用；
- 旧源码服务和每分钟 update timer 不再存在，旧数据只在用户确认后永久删除。

## 实施前唯一依赖决策

本计划可以在不新增第三方依赖的前提下完成。若实现时为了共享本机 control 协议，需要给
`@cinba/product-runtime` 新增一个 workspace runtime dependency，按照仓库约束先向用户确认；优先扩展
它已经依赖的 `@cinba/core-client` 和已有 product-runtime Sync control 模块，避免不必要的依赖边。
