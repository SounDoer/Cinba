# Desktop 多 Core 导航实施计划

日期：2026-09-15  
状态：代码已完成；Windows 视觉验收与 macOS 双 Core 实机验收待完成  
对应设计：`docs/specs/2026-09-15-desktop-multi-core-design.md`

> 2026-09-16 后续修正：本文中的本机 persistent 与组合退出验收已由
> `docs/specs/2026-09-16-desktop-local-core-lifecycle-design.md` 取代；Profile、窗口隔离和远程
> Core 边界继续有效。

## 目标与完成标准

把现有“打开窗口就启动 `127.0.0.1:4517`”的 Desktop 改成独立于任一 Core 的客户端外壳：

- 第一次启动默认打开 Local Core，此后恢复上次使用的 Profile；
- Desktop 可添加、编辑、删除和测试远程 HTTPS Core；
- 主窗口顶部可在 Local、Home Mac、VPS 等 Profile 之间切换；
- Local Profile 才能启动本机 Core，Remote Profile 永远不调用本机生命周期控制；
- 目标离线时 Desktop shell 仍可重试、修改地址或选择其它 Core；
- 每个 Core 继续提供自己的完整 Web UI，Desktop 不理解聊天协议；
- Tray/Menu Bar 可直接打开任意 Core，本机控制菜单明确标注 `Local Core`；
- 本地 shell、远程 Core 内容和 Electron 主进程之间保持窄而可验证的安全边界；
- Windows 与 macOS 完成真实双 Core 验收；
- `npm run check` 完整通过。

第一版保持单主窗口，不做自动发现、远程进程控制、Profile 同步、故障转移、多窗口恢复、TUI
选择器或跨 Core 会话迁移。

## 实施原则

1. Profile、URL 和窗口决策先写成不依赖 Electron 的纯模块，用 Node 测试固定语义。
2. Desktop shell 与 Core 页面使用独立 web contents；不修改或注入 Core Web UI。
3. 只有 `kind: "local"` 的内置 Profile 可以进入 `@cinba/core-manager`。
4. 远程页面只从自身 origin 加载资源并连接 `/ws`，Desktop 不构造聊天 WebSocket。
5. 打开失败不自动回退到另一台机器，也不把 Profile label 当成 Core identity。
6. Profile 文件损坏时保留原文并报告，不以空配置覆盖。
7. Electron 事件处理尽量只做适配；状态变换和菜单映射放在可单测函数中。
8. 不新增 runtime dependency。Desktop shell 使用仓库已有的 Vite 能力和原生 DOM；若实施中发现
   确实需要新的 runtime dependency，先停止并征得用户同意。

## 预期文件形状

具体命名可在实现时小幅调整，但职责保持：

```text
packages/desktop/
├── package.json
├── tsconfig.json
├── tsconfig.shell.json
├── vite.config.ts
├── shell/
│   ├── index.html                 # 顶部 shell 与离线状态
│   └── manage.html                # Manage Cores 窗口
└── src/
    ├── main.ts                    # Electron 启动与组合
    ├── profiles.ts                # 类型、规范化和校验
    ├── profile-store.ts           # desktop.json 持久化
    ├── profile-store.test.ts
    ├── navigation-policy.ts       # origin 与外链决策
    ├── navigation-policy.test.ts
    ├── window-model.ts            # 纯状态与竞态决策
    ├── window-model.test.ts
    ├── window.ts                  # BaseWindow/WebContentsView 适配
    ├── desktop-preload.cjs        # shell 专用窄 IPC bridge
    ├── ipc.ts                     # IPC 注册与输入校验
    ├── tray.ts
    ├── tray.test.ts
    └── shell/
        ├── global.d.ts
        ├── main.ts
        ├── manage.ts
        └── style.css
```

构建产物仍进入被 `.gitignore` 排除的 `dist/`。Core 自己的 Web UI 继续来自
`packages/web/dist`，Desktop shell 使用自己的构建输出，两者不复用运行时状态。

## 阶段 1：Profile 模型与 URL 规则

### 改动

在 `packages/desktop/src/profiles.ts` 定义：

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

内置 Local Profile 只由代码生成。磁盘文件只接受远程条目，不能用 `id: "local"` 覆盖本机地址。

远程输入规范化规则：

- label trim 后非空并限制合理长度；
- URL 只接受 `https:`；
- 拒绝 userinfo、query、fragment 和非根路径；
- origin 规范化为带结尾 `/` 的 `URL.origin`；
- ID 使用 `crypto.randomUUID()`，编辑时保持原 ID；
- 规范化后的 origin 不得重复；
- URL 不可达不影响静态校验。

将“输入是否合法”与“目标现在是否在线”分开，避免休眠中的 Mac 无法加入清单。

### 测试

- 合法 Tailscale HTTPS URL 被规范化；
- 空 label、HTTP remote、userinfo、query、fragment、子路径被拒绝；
- 大小写、默认端口与尾部 `/` 规范化后正确查重；
- 磁盘伪造 `local` Profile 无法覆盖内置项；
- 编辑保持 ID，新增生成唯一 ID；
- 返回对象为副本，调用者不能绕过 store 修改内存。

### 完成条件

Profile 的安全和相等语义完全由纯测试证明，不依赖 Electron 或真实网络。

## 阶段 2：Desktop Profile Store

### 改动

在 `packages/desktop/src/profile-store.ts` 实现：

```ts
type DesktopSettings = {
  version: 1;
  profiles: RemoteCoreProfile[];
  lastProfileId: string;
};
```

默认路径取 `createLocalCoreConfig().stateDirectory` 下的 `desktop.json`。Store 对外提供：

- `list()`：Local 在前，随后为保存顺序中的远程 Profile；
- `get(id)`；
- `add(input)`；
- `update(id, input)`；
- `remove(id)`；
- `lastSelected()`；
- `select(id)`：目标存在时才更新 `lastProfileId`；
- `subscribe(listener)`：让 shell 与 tray 在同一进程中同步重建视图。

落盘采用同目录临时文件、写完关闭后原子 rename。POSIX 上目录尽可能为 `0700`、文件为 `0600`；
Windows 依赖用户目录 ACL，不作虚假 mode 承诺。

读取分三类：

1. 文件不存在：返回 Local + 空远程清单；
2. 单条 Profile 非法：隔离该条、保留其它有效条目并暴露 warning；
3. JSON 或顶层 schema 损坏：进入只读错误状态，保留原文件，拒绝写操作直到用户在 Manage Cores
   中明确修复或重置。

第一版删除当前 Profile 时拒绝并提示先切换，避免窗口突然指向不存在的选择。

### 测试

- 缺失文件得到默认 Local，首次选择后创建文件；
- 合法条目顺序、lastProfileId 和重启读取一致；
- lastProfileId 缺失或指向已不存在条目时回到 Local；
- add/update/remove/select 原子保存完整文档；
- 重复 origin 与保留 ID 被拒绝；
- 单条损坏被隔离并产生 warning；
- 整体损坏不被下一次普通写操作覆盖；
- 原子写入不遗留临时文件，支持的平台验证权限；
- subscriber 只在成功提交后收到新快照。

### 完成条件

手工删除、破坏或降级 `desktop.json` 不会导致 Profile 被悄悄清空。

## 阶段 3：可测试的窗口与连接决策

### 改动

在碰 Electron 窗口前，先建立纯状态模型：

```ts
type WindowState =
  | { type: "idle"; profileId: string }
  | { type: "opening"; profileId: string; requestId: number }
  | { type: "online"; profileId: string; requestId: number }
  | { type: "offline"; profileId: string; requestId: number; message: string };
```

每次选择或 Retry 都生成递增 `requestId`。Health probe、`ensureLocalCore()` 或页面加载晚到时，仅当
`requestId` 仍是当前请求才允许更新 UI，防止：

```text
先点 Home Mac（慢）
→ 再点 VPS（快）
→ Home Mac 的旧结果最后回来并覆盖 VPS
```

抽出打开策略：

```text
Local  → ensureLocalCore(on-demand) → probe → load
Remote → probe                      → load
```

Remote 路径的类型和测试必须使其无法调用 `ensureLocalCore`。Probe 使用
`@cinba/core-client` 的 `probeCoreHealth()` 并设置有限超时；只确认合法 Cinba health response，不
推断 Core identity。

### 测试

- 首次状态选择 Local；已有设置选择 lastProfileId；
- Local 打开一次且只调用本机 ensure；
- Remote 打开从不调用本机 ensure；
- probe 失败进入对应 Profile 的 offline 状态；
- 不可达时不自动切 Local；
- Retry 保持 Profile 并产生新请求；
- 旧 ensure/probe/load 成功或失败不能覆盖较新的选择；
- 编辑当前 Profile URL 后重新打开同一 ID 的新地址；
- 关闭窗口使未完成请求失效。

### 完成条件

机器选择和异步竞态在纯测试里固定，Electron 适配层不自行发明状态。

## 阶段 4：Desktop shell 构建与窄 IPC

### 构建

- 在 `@cinba/desktop` 增加 `build` 脚本和 Vite 开发依赖声明；不增加 React；
- shell 使用原生 TypeScript、DOM 和 CSS；
- `tsconfig.shell.json` 使用 DOM lib 与 Bundler resolution，主进程 `tsconfig.json` 继续只面向 Node；
- Vite 构建 `index.html` 与 `manage.html`，输出到 Desktop 自己的 `dist/`；
- shell HTML 设置严格 CSP，不允许远程 script、任意 connect 或 inline script。

### IPC

本地 shell 使用独立 preload，只暴露逐项能力：

```ts
type CinbaDesktopApi = {
  getState(): Promise<DesktopViewState>;
  selectProfile(profileId: string): Promise<void>;
  retry(): Promise<void>;
  openManager(): Promise<void>;
  onStateChanged(listener: (state: DesktopViewState) => void): () => void;
};
```

Manage 窗口额外获得经过校验的 `addProfile`、`updateProfile`、`removeProfile` 和 `testConnection`。
不要暴露任意 IPC channel、任意 URL 加载、文件路径或 Core control token。所有 renderer 输入在主进程
再次验证，不能因页面是本地文件就跳过边界校验。

Preload 保持极薄；事件订阅返回明确 unsubscribe，窗口销毁后移除 listener。

### 测试与检查

- IPC handler 用假的 store/window controller 测试允许操作与非法输入；
- 未知 Profile ID、无效 URL 和错误 payload 在主进程被拒绝；
- shell typecheck 与 build 通过；
- 检查构建后的 HTML 不含 inline script、远程资源或 secret。

### 完成条件

本地 shell 可以展示 Profile 和状态、发出选择命令，但远程内容还没有被赋予任何 shell API。

## 阶段 5：隔离的窗口与 Core content

### 窗口结构

将现有单个 `BrowserWindow.loadURL()` 改为一个原生主窗口中的两个独立内容边界：

```text
Desktop shell view  → file://.../desktop/dist/index.html
Core content view   → currentProfile.baseUrl
```

保持系统原生窗口边框；Core selector 是标题栏下方的轻量 toolbar，不在第一版实现自绘最小化、最大化
或关闭按钮。

主进程负责 resize 时的布局：在线时 shell 固定顶部高度、Core content 填满剩余区域；opening/offline
时 shell 可覆盖内容区域展示状态。切换 Profile 时关闭旧页面连接并加载完整的新页面，不操作页面
内部 React state。

使用的 Electron 窗口原语若不会随原生窗口自动销毁 web contents，`closed` 路径必须显式 close
两个 view，并在真实运行中确认没有残留 renderer 或 WebSocket。

### 导航策略

在 `navigation-policy.ts` 纯函数基础上挂接 Electron 事件：

- Core content 主导航只允许当前 Profile 的精确 origin；
- 同 origin 页面导航允许；
- 普通跨 origin `http(s)` 链接阻止内嵌导航并交给 `shell.openExternal()`；
- `javascript:`、`data:`、`file:` 和其它 scheme 直接拒绝；
- `setWindowOpenHandler` 默认 deny，可信外链只走系统浏览器；
- 不处理或绕过 certificate error；
- 不给 Core content 配置 preload、Node integration 或 Electron API；
- 保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。

导航判定必须按解析后的 URL/origin 比较，不能用字符串前缀；例如
`https://trusted.example.evil.test` 不能匹配 `https://trusted.example`。

### 加载失败

- probe 失败时不加载 Core view，shell 展示 offline；
- `did-fail-load`、renderer crash 或主文档意外离开允许 origin 时回到可操作错误态；
- 加载失败不销毁主窗口；
- Retry 重走 ensure/probe/load；
- 选其它 Profile 立即取消旧请求的 UI 所有权。

### 测试与手工验证

- 精确 origin、相似恶意 hostname、scheme、同 origin path 的策略单测；
- window adapter 用可注入 fake views 验证布局、销毁和 load 调用；
- 手工确认切换后旧 Core 客户端计数下降，隐藏页面没有残留 WebSocket；
- 手工确认 Markdown 外链在系统浏览器打开，不能替换 Desktop shell。

### 完成条件

Desktop 可在 Local 和一个 Remote Profile 间往返，页面版本分别来自目标 Core，离线时 App 不消失。

## 阶段 6：Manage Cores

### 改动

实现本地 `manage.html` 窗口：

- Local Core 固定显示，URL 锁定且没有删除按钮；
- 远程 Profile 列出 label、规范化 URL 和最近一次测试结果；
- Add/Edit 表单只含 label 与 URL；
- `Test Connection` 不保存，使用表单当前值；
- `Save` 即使测试失败也允许，但静态 URL 校验必须通过；
- 当前 Profile 可以编辑，保存后主窗口重新打开更新后的地址；
- 当前 Profile 不能删除，UI 和主进程两层拒绝；
- 非当前 Profile 删除前要求一次明确确认；
- store warning 或整体损坏显示具体文件路径和恢复选择，不静默重置。

测试结果只表达 `reachable`、`unreachable`、revision 和 `safeToRestart`；不把 Profile label 显示成
已经由 Core 验证的身份。

### 测试

- 表单静态校验与主进程结果一致；
- Test 不改变 store；
- 离线 URL 可以保存；
- 保存当前 Profile 触发主窗口重连；
- 删除当前、Local 或未知 Profile 被拒绝；
- Manage 窗口重复打开时聚焦既有窗口，不产生多份编辑状态；
- store 更新后主窗口选择器和 tray 同步更新。

### 完成条件

用户无需编辑 JSON 即可完成第二个 Core 的添加、修正和删除。

## 阶段 7：Tray / Menu Bar

### 改动

扩展现有纯 `createTrayViewModel()`，把 Profile 列表与 Local Core 状态组合成两组菜单：

```text
Open Core
├── Local Core
├── Home Mac
└── VPS

Local Core
├── Status: running
├── Start Local Core
├── Stop Local Core Gracefully
├── Refresh Local Core Status
└── Open Local Core Log
```

- 顶层 `Open Cinba` 聚焦现有窗口；没有窗口时打开 lastProfileId；
- Profile 子项在同一主窗口打开目标；
- Profile store 变化后重新构建菜单；
- 现有 2 秒轮询仍只探测 Local Core，不轮询所有远程 Core；
- `starting`/`stopping` 操作只禁用 Local 控制，不应阻止用户打开 Remote Profile；
- tooltip 和错误文字明确指向 Local Core，不能让查看 VPS 时显示成在控制 VPS；
- 普通 `Quit Desktop` 不停止其它客户端；需要立即停止时使用独立的 graceful stop。

这一步需要把当前 tray 中用一个 `operation` 包住 `openWindow()` 的结构拆开：打开 Remote 不属于
`starting`，打开 Local 才可能触发 ensure。窗口导航错误与 Local 生命周期错误分别保存和呈现。

### 测试

- Profiles 按保存顺序生成菜单，Local 固定在首位；
- 点击 Remote 只调用窗口导航；
- 点击 Local 由窗口控制器进入 ensure 路径；
- Local 正在启停时 Remote 菜单仍可用；
- 所有生命周期 label 含 `Local Core`；
- external local Core 继续只读，不能 stop；
- 现有图标位图、PID、Clients、draining 和 Quit 测试不回归。

### 完成条件

Tray/Menu Bar 同时是 Core 快捷入口和本机 Core 控制器，但菜单结构不会混淆两种职责。

## 阶段 8：启动器、构建与文档接线

### 改动

- `@cinba/desktop` 增加 shell build/typecheck；
- 根 `npm run build` 同时构建 `@cinba/web` 和 `@cinba/desktop`；
- `scripts/launch.ts` 的 Desktop 路径在启动 Electron 前确保两个产物存在；
- `npm run dev` 仍只服务 Web 开发和 Dev Core，不自动启动 Desktop shell 开发服务器；
- `cinba desktop`、`npm run desktop`、`.cmd` 和 `.command` 入口保持原命令与单实例语义；
- 第二次启动 Desktop 时聚焦现有窗口，不改变当前 Profile；
- 更新 CLI/README 中 Desktop 的一句说明，使其表达“本机 Core 控制器 + 多 Core 客户端”；
- 实施完成后更新设计、计划和主设计状态。

### 测试

- launcher 测试验证 Desktop 启动前构建两个目标；
- Desktop package 主进程与 shell 分别 typecheck；
- 根 build 在干净 dist 状态下生成 Web UI 和 Desktop shell；
- 单实例第二次启动不额外创建窗口或切回 Local。

### 完成条件

开发仓库入口与以后打包入口使用同一套 Desktop shell 和 Profile store，不出现只在某个脚本可用的
旁路。

## 阶段 9：自动化与真实验收

### 自动化顺序

1. `node --test --experimental-strip-types "packages/desktop/src/**/*.test.ts"`
2. `npm run typecheck --workspace @cinba/desktop`
3. `npm run build --workspace @cinba/desktop`
4. `npm test`
5. `npm run check`

Electron 窗口行为不能只靠 mock。自动化全绿后，在 Windows 和 Home Mac 各做一次真实验收。

### Windows 验收

1. 备份并暂时移走测试用 `desktop.json`，首次打开确认进入 Local；
2. 添加 VPS HTTPS Profile，Test Connection 成功；
3. 切到 VPS，确认没有因为切换额外启动 Local Core；
4. 页面中 Core identity 与 VPS 一致；
5. 关闭 VPS 或使用不可达测试地址，确认 shell、选择器和 Manage Cores 仍可用；
6. 切回 Local，确认按需启动且保持 on-demand；
7. 关闭窗口后旧 WebSocket 断开，tray 仍存在；
8. 重启 Desktop，确认恢复上次 Profile；
9. 外链进入系统浏览器，远程页面不能替换 shell；
10. Start/Stop/Log 菜单只影响 Windows Local Core。

### macOS 验收

1. Menu Bar 正常显示并能打开 last Profile；
2. Local Profile 管理 Home Mac Stable Core；
3. 添加并打开 VPS Profile，Home Mac Core 不被无条件启动；
4. Mac 睡眠/网络切换后的离线与 Retry 状态可恢复；
5. Profile 文件、窗口选择和 Menu Bar 清单在重启后保持；
6. 关闭主窗口不会退出 Desktop；Local Core 无客户端后按安全空闲规则退出；
7. `Stop Local Core Gracefully` 仍走 draining，而不是强杀；普通退出不留下 persistent Core。

测试期间保存用户原有 `desktop.json`，结束后恢复；不得覆盖真实 Profile 或 Core 配置。

### 最终完成条件

- 两个平台自动化和真实窗口行为一致；
- Local/Remote 生命周期边界没有旁路；
- 离线、切换、外链、关闭和重启路径均可恢复；
- `npm run check` 全绿；
- 设计、计划和主设计标记为已实施并记录真实验收日期。

## 建议提交边界

保持 `master` 线性历史，按可独立验证的完成面提交：

1. `feat(desktop): add persistent core profiles`
2. `feat(desktop): add isolated multi-core shell`
3. `feat(desktop): add core profile management`
4. `feat(desktop): expose core profiles in tray menu`
5. `docs(desktop): record multi-core verification`

每个提交前运行相关 package 测试；最终提交前运行 `npm run check`。如果实现阶段需要改动提交拆分，
仍保持每个提交可构建、可测试且不留下半套安全边界。

## 实施记录（2026-09-16）

- 纯连接状态模块最终命名为 `core-navigator.ts`，IPC 注册保留在较小的 `main.ts`，没有为了匹配
  计划草图机械拆文件；
- Desktop 直接用有限超时的 `/healthz` 请求验证远程入口，避免为一个请求新增 runtime dependency；
- 主窗口采用 `BrowserWindow` 承载本地 shell，并用独立、无 preload 的 `WebContentsView` 承载 Core
  页面；每次选择都会销毁旧 view，避免离线目标留下旧 Core WebSocket；
- 损坏的顶层设置进入只读错误态；Manage Cores 可在用户明确确认后保留原文件备份并重建设置；
- `npm run check` 已在 Windows 开发机通过；Electron 真实启动、Local health、窗口标题和客户端连接已
  验证。当前自动化环境无法读取原生 Electron 窗口，因此视觉布局、真实 VPS 切换与 macOS 行为仍按
  第 9 阶段清单待实机验收。
