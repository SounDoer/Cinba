# Desktop 多 Core 导航设计

日期：2026-09-15  
状态：已实施；Windows 视觉验收与 macOS 双 Core 实机验收待完成  
实施计划：`docs/plans/2026-09-15-desktop-multi-core.md`

## 1. 背景

Cinba 已经在 VPS 上运行，家里的 Mac 也将运行一个独立 Core。两台机器位于同一个 Tailscale
网络，但各自拥有独立的项目目录、会话、模型凭据、工具权限和 shell：

```text
VPS Core       → VPS 的文件、进程、凭据和会话
Home Mac Core  → Mac 的文件、进程、凭据和会话
```

Web 第一版把一个 Core 表达成一个完整站点。页面由该 Core 提供，并连接同一来源的 `/ws`：

```text
https://cinba-vps.example.ts.net/ → VPS Core 提供的 Web UI + WebSocket
https://cinba-mac.example.ts.net/ → Mac Core 提供的 Web UI + WebSocket
```

因此两个书签已经能完成选择，但 Desktop 目前只认识 `http://127.0.0.1:4517/`，且每次打开窗口
都会先启动本机 Core。随着真实的第二个 Core 出现，Desktop 需要成为独立于任一 Core 的入口。

## 2. 产品原则

一句话边界：

> **Web UI 管理“这个 Core 里面有什么”；Desktop 管理“我要进入哪个 Core”。**

这意味着：

- Core 继续是一个独立、自包含、可以直接用浏览器访问的 Cinba 实例；
- Web UI 继续由当前 Core 提供，不保存或管理其它 Core；
- Desktop 在任何 Core 之外保存 Core Profiles，并负责选择、导航和本机 Core 生命周期；
- 不安装 Desktop 时，浏览器与 TUI 的现有用法完全不变；
- Core 之间不互相发现、不同步 Profile，也不引入“主 Core”。

这个功能在产品上称为 **Core Navigator**。它不是 Web UI 的 Core Switcher，也不是跨 Core
会话同步。

## 3. 为什么归 Desktop，而不是 Web

### 3.1 Profile 必须在 Core 离线时仍然存在

若 Profile 存在某个 Core 上，客户端必须先连上那个 Core 才知道其它 Core 在哪里：

```text
想从 VPS 切到 Home Mac
→ 先连接 VPS 读取清单
→ VPS 恰好离线
→ 连 Home Mac 的地址也拿不到
```

这使选择入口依赖被选择对象，方向倒置。

若存在浏览器 `localStorage`，不同 Core 的 HTTPS origin 又会得到互不相通的多份清单。用户在
VPS 页面添加的 Profile 不会自然出现在 Mac 页面。

Desktop 自己保存清单后，即使所有 Core 都离线，App 仍能显示目标、编辑地址并重新连接。

### 3.2 每个 Core 使用与自己匹配的 Web UI

Desktop 不内置一套统一聊天客户端去连接所有版本的 Core，而是加载目标 Core 自己提供的页面：

```text
Desktop
├── Home Mac → Core v1.8 提供 Web UI v1.8
└── VPS      → Core v1.5 提供 Web UI v1.5
```

因此 Desktop 不理解 `@cinba/contract` 的聊天协议，不需要为不同部署进度提前引入协议协商、功能
探测或长期向后兼容。它只需要理解稳定得多的页面入口和 `/healthz`。

### 3.3 Profile 标签不是真实身份

Profile 的 `label` 是客户端记住的入口名称，例如 `VPS`；Core 的 `core_identity` 是服务器自己
声明的真实身份，例如 `cinba-vps`。两者职责不同：

- Desktop chrome 展示 Profile label，帮助选择地址；
- Core Web UI 继续常驻展示服务器声明的名称和颜色，帮助确认 shell 实际属于哪台机器；
- 第一版不以 Profile label 替换或伪造 Core identity。

外层若将来需要自动比较两者，应新增一个明确、可信的身份读取边界，而不是从页面标题或 DOM
猜测。第一版不为此扩大协议。

## 4. 总体结构

```text
┌─────────────────────────────────────────────────────┐
│ Cinba Desktop                                       │
│                                                     │
│  本地 Desktop shell                                 │
│  ┌───────────────────────────────────────────────┐  │
│  │ Cinba   [ Home Mac ▼ ]   [Manage Cores…]     │  │
│  └───────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────┐  │
│  │ 目标 Core 提供的完整 Web UI                   │  │
│  │                                               │  │
│  │ sessions / chat / settings / permissions      │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘

Desktop shell
├── Core Profiles
├── 当前窗口的 profileId
├── 离线、加载与配置错误界面
└── @cinba/core-manager → 只管理本机 Stable Core

Core content
└── 独立且沙箱化的页面容器 → profile.baseUrl
```

外层 shell 和 Core content 必须是两个独立的页面边界。不能把本地 Profile API 注入远程 Core
页面，也不能用脚本向 Core Web UI 的 DOM 插入切换器。

Electron 44 已提供承载多个独立 web contents 的窗口原语。实施计划再决定具体类与布局代码；设计
要求是 shell 与远程内容各自隔离、由主进程控制边界，而不是依赖某个易变的 Electron 类名。

## 5. Core Profile

### 5.1 运行时模型

```ts
type LocalCoreProfile = {
  id: "local";
  kind: "local";
  label: string;
  baseUrl: "http://127.0.0.1:4517/";
};

type RemoteCoreProfile = {
  id: string;
  kind: "remote";
  label: string;
  baseUrl: string;
};

type CoreProfile = LocalCoreProfile | RemoteCoreProfile;
```

`local` 是 Desktop 生成的内置 Profile，不从磁盘接受覆盖，不能编辑地址或删除。标签可按平台显示
为 `This Mac` 或 `This PC`，但 ID 和地址稳定。

远程 Profile 只保存 Web 页面 `baseUrl`。不单独保存 WebSocket URL；页面继续从自己的
`location.host` 得到 `/ws` 地址。

### 5.2 持久化

Desktop 设置独立保存为 `~/.cinba/desktop.json`：

```json
{
  "version": 1,
  "profiles": [
    {
      "id": "8f32208c-37d2-4ff5-98a5-df93282476a8",
      "label": "VPS",
      "baseUrl": "https://cinba-vps.example.ts.net/"
    }
  ],
  "lastProfileId": "8f32208c-37d2-4ff5-98a5-df93282476a8"
}
```

该文件只保存远程 Profile 和 Desktop 偏好；本机 Profile 在读取后合成。它不能并入 Core 自己的
`~/.cinba/config.json`，因为后者由 Server 拥有，保存的是某一个 Core 的 cwd、model、session、
coreName 和扩展设置。

写入使用同目录临时文件后原子替换，并尽可能限制为当前操作系统用户可读。文件整体损坏时保留
原文件、显示可操作错误，不静默覆盖成空清单；单条无效 Profile 可以隔离并报告，其余有效条目
继续使用。

### 5.3 校验和规范化

远程 `baseUrl` 必须满足：

- 使用 `https:`；`http:` 只允许内置 loopback Profile；
- 不含用户名、密码、query 或 fragment；
- 第一版只接受 origin 根路径，因为当前静态页面与 `/ws` 都按根路径部署；
- 保存前规范化尾部 `/`；
- 不允许两个远程 Profile 指向规范化后的同一 origin；
- label 去掉首尾空白且不能为空；
- URL 格式正确但暂时不可达时仍允许保存，Home Mac 可能正在休眠。

Profile 不保存 Tailscale 凭据、Cinba token 或证书例外。网络认证继续由操作系统里的 Tailscale
身份、Grant 和 HTTPS 证书承担。

## 6. 打开与切换

窗口控制器改为接受 Profile，而不是无条件启动本机 Core：

```text
open(local)
→ ensureLocalCore({ lifetime: "persistent" })
→ 加载 http://127.0.0.1:4517/

open(remote)
→ 不调用 ensureLocalCore()
→ 探测并加载 profile.baseUrl
```

切换的定义是销毁或导航旧的 Core content，再为目标加载完整页面。Desktop 不保留旧页面里的
React state，不替换页面内部 `CoreClient` 的 URL，也不缓存或重放断线前的命令。

打开远程 Core 绝不能顺带启动本机 Core。反过来，停止本机 Core也不能关闭正在查看远程 Core 的
Desktop 窗口。

### 6.1 启动选择

建议行为：

- 第一次运行没有记录时打开 Local Core，保持现有行为；
- 此后打开上次使用的 Profile；
- 上次 Profile 离线时显示该 Profile 的离线界面，不静默回退到 Local Core；
- 用户从选择器明确切换，避免在错误机器上执行命令。

不自动回退是安全选择：可用性不能以悄悄改变 shell 所在机器为代价。

### 6.2 断开与进行中的任务

切换页面会关闭旧 WebSocket，语义与用户关闭浏览器标签一致：

- 已经提交给 Core 的普通 agent 工作继续由 Core 持有；
- 若最后一个查看当前 session 的客户端离开，待处理权限确认继续遵守现有严格拒绝规则；
- Desktop 不尝试把运行中状态迁移到另一个 Core；
- 第一版不新增切换前确认弹窗，避免把“服务上任何 session 忙碌”和“当前页面不能离开”混为
  一谈。真实使用若出现误切，再根据当前 session 的可信状态设计提醒。

## 7. Shell 交互

### 7.1 主窗口

第一版主窗口顶部提供：

```text
[当前 Profile ▼]  [Retry]  [Manage Cores…]
```

选择器列出内置 Local Core 和所有远程 Profile。窗口标题同步显示 `Cinba — <Profile label>`。
Profile label 只表达入口，Core content 内仍显示服务器身份和颜色。

### 7.2 Manage Cores

第一版提供最小但完整的管理界面：

- 列出远程 Profile；
- 添加 label 与 HTTPS URL；
- 编辑 label 与 URL；
- 删除非当前远程 Profile；
- 手动 Test Connection；
- URL 离线时可以保存；
- Local Core 可见但地址锁定、不可删除。

第一版不做拖动排序、文件导入导出、云同步、自动发现或 Tailscale 设备枚举。Profile 按用户保存
顺序显示；实现可以提供简单的上移、下移，也可以留到后续，不影响数据模型。

### 7.3 离线界面

目标不可达或未通过 Cinba `/healthz` 校验时，外层 shell 保持可用，内容区域显示：

```text
Home Mac is unavailable
https://cinba-mac.example.ts.net/

[Retry] [Edit Profile] [Choose Another Core]
```

不得销毁整个 Desktop、显示空白 Chromium 错误页或自动打开另一个 Core。

`Test Connection` 和打开前探测只证明目标返回合法 Cinba health response。当前 `/healthz` 不返回
Core identity，因此第一版不宣称探测已经验证 Profile label 与机器名称一致。

## 8. Tray / Menu Bar 与本机生命周期

Tray/Menu Bar 同时承担两个不同但明确分组的入口：

```text
Open Core
├── Local Core
├── Home Mac
└── VPS

Local Core
├── Status: running
├── Start Local Core
├── Stop Local Core Gracefully
└── Open Local Core Log

Quit Desktop
```

现有 `Start Core`、`Stop Core Gracefully` 和 `Open Core Log` 改名明确带上 `Local`。它们始终通过
`@cinba/core-manager` 操作当前机器的 Stable Core，与窗口正在显示哪个 Profile 无关。

远程 Profile 第一版只有打开和连通性状态，没有启动、停止、部署、查看 PID 或远程日志能力。
Tailscale 网络可达不等于拥有远程进程控制权。

## 9. 窗口模型与多窗口演进

第一版可以只保留一个主窗口，在其中切换 Profile；但实现不能把选择状态做成进程级且无窗口归属
的隐式全局。窗口控制器的逻辑模型应是：

```text
Desktop
├── profiles
├── windows
│   └── windowId → profileId
└── localCoreManager
```

这样后续增加 `Open in New Window` 时，每个窗口可以独立连接一个 Core，而 Profile 存储和本机
生命周期逻辑无需重写。

第一版不要求同时创建多个窗口，也不要求恢复上次所有窗口。是否把多窗口纳入首发见第 13 节。

## 10. Electron 安全边界

加载远程 Core 页面后，现有浏览器安全设置继续成立，并增加导航约束：

- Core content 保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；
- 远程内容与本地 shell 使用独立 web contents；
- 远程内容不能获得 Profile 读写、本地 Core token、文件系统或 Electron API；
- 主内容只允许加载当前 Profile 的精确 origin；
- 同 origin 的 Cinba 页面导航可继续，跨 origin 普通链接交给系统浏览器；
- 拒绝 `javascript:`、`data:`、`file:` 等非预期导航；
- 拦截新窗口请求，可信的普通 HTTPS 外链只在系统浏览器打开；
- 不绕过系统证书错误，不为 Tailscale 域名建立自定义信任；
- shell 到主进程若需要 IPC，只暴露逐项、窄作用域的 Profile 操作，不提供任意消息转发或文件访问。

Core Profile 是用户明确授权 Desktop 访问的地址清单，但不因此获得本机能力。

## 11. 包与协议边界

本功能主要落在 `@cinba/desktop`：

```text
packages/desktop
├── profile store / validation
├── Desktop shell
├── window and content navigation
├── tray/menu integration
└── @cinba/core-manager → local only
```

- `@cinba/contract` 不变：Core 之间没有新协议，三个现有客户端无需跟着修改；
- `@cinba/core-client` 只复用 HTTP health probe，不变成多 Core 状态管理器；
- `@cinba/server` 不保存 Desktop Profiles，也不增加发现 API；
- `@cinba/web` 继续只连接自己的 origin，不出现 Core 切换组件；
- `@cinba/core-manager` 继续只认识本机 Stable Core。

Desktop shell 应保持很薄。第一版交互不足以证明需要新增前端 runtime dependency；实施计划优先
使用 Electron 与仓库已有构建能力完成。如果最终确实需要新增 runtime dependency，按仓库规则先
征得用户同意。

## 12. 第一版范围与验收

### 12.1 包含

- 内置、不可删除的 Local Core Profile；
- 独立 `desktop.json` 的读取、校验、原子写入和错误呈现；
- 远程 Profile 增删改与 Test Connection；
- 主窗口可选择和切换 Profile；
- Local 与 Remote 打开路径严格分离；
- 记住上次使用的 Profile；
- Core 离线时 shell 仍可操作；
- Tray/Menu Bar 可直接打开任意 Profile；
- 本机生命周期菜单显式标注 Local；
- 精确 origin 导航限制和外链处理；
- Profile store、URL 校验、窗口决策、菜单映射的 Node 单元测试；
- Windows 与 macOS 的真实窗口、切换、离线和本机生命周期手工验收；
- `npm run check` 完整通过。

### 12.2 不包含

- Browser Web UI 内的 Core 清单；
- Core 自动发现、mDNS 或读取 Tailscale 设备列表；
- Core 之间同步 Profile、会话、模型或凭据；
- 远程 Core 启停、部署、日志和系统管理；
- 静默故障转移或负载均衡；
- Profile 云同步、账号系统或密钥保存；
- 把运行中的 agent 或权限确认迁移到另一个 Core；
- TUI 交互式 Core 选择器；`CINBA_SERVER` 继续满足其入口需求。

## 13. 已确认的产品选择

以下三项于 2026-09-15 确认，实施计划以此为准。

### 13.1 启动时打开哪里

**决定：第一次打开 Local，以后打开上次使用的 Profile。**

备选是每次都打开 Local。前者更像真正的多 Core App，也避免 VPS 是日常主力时每次多切一步；后者
延续当前行为但会无条件拉起本机 Core。

### 13.2 多窗口是否首发

**决定：第一版单窗口切换，数据和控制器保留一窗口一 Profile 的演进空间。**

多窗口价值明确，但会同时扩大窗口恢复、tray 聚焦、关闭语义和测试矩阵。先验证 Profile 与远程
导航边界，再增加 `Open in New Window`，风险更可控。

### 13.3 Profile 管理做到哪一层

**决定：第一版直接包含最小 Manage Cores 界面，不要求用户手改 JSON。**

仅提供配置文件能更快验证底层，但 Cinba Desktop 的目标是成为可见的个人客户端；添加第二个
Core 是主流程，不应长期依赖文本编辑器。管理页仍只需要 label、URL、测试、保存和删除。

## 14. 后续演进

真实使用稳定后可以依次考虑：

1. `Open in New Window`，同时观察和操作多个 Core；
2. 在 shell 中显示最近一次 health 状态、revision 与连接时间；
3. Profile 导入导出，帮助另一台个人设备复用清单；
4. 打包、签名和 notarize 后的 Open at Login；
5. 手机原生 Cinba App 复用同一层级：App 管 Profile，Core 提供 Web UI 或原生内容客户端。

这些都不得反向要求 Web UI 保存 Core 清单，也不得让某个 Core 成为其它 Core 的目录服务。
