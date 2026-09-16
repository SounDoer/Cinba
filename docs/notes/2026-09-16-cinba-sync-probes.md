# Cinba Sync 关键技术探针

日期：2026-09-16  
对应设计：`docs/specs/2026-09-16-cinba-sync-design.md`  
对应计划：`docs/plans/2026-09-16-cinba-sync.md`  
状态：阶段 0 完成，尚未进入功能开发

## 1. 范围与证据

本记录只回答会决定后续实现形状的三个问题：Pi Provider 凭据如何进入 RPC 子进程、Desktop 能否
安全承载另一个 HTTPS origin，以及 Node 24 的文件与加密原语在目标平台上的边界。探针没有加入
产品代码，也没有使用真实 secret。

证据基线：

- 仓库依赖 `@earendil-works/pi-coding-agent@0.85.1`、Electron `44.2.0`，要求 Node `>=24`；
- Windows 实机：Node `24.19.0`、OpenSSL `3.5.7`、Electron `44.2.0`、Chromium
  `152.0.7977.76`、NTFS；
- Linux 实验：Docker 中的 Node `24.21.0`、OpenSSL `3.5.8`；
- 当前没有可执行的 macOS 主机。macOS 结论来自 Node 24 的跨平台 API 和 Apple 的 `rename(2)`
  语义，真实 Mac 仍按计划留到阶段 10/12 验收，不能把它写成已经实机通过。

引用的权威资料：

- Pi 随当前依赖发布的 `docs/providers.md`、`docs/sdk.md`、`docs/rpc.md`，以及
  `@earendil-works/pi-ai/dist/env-api-keys.js`；
- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)、
  [Session](https://www.electronjs.org/docs/latest/api/session)、
  [WebContents](https://www.electronjs.org/docs/latest/api/web-contents) 和
  [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)；
- [Node 24 File system](https://nodejs.org/docs/latest-v24.x/api/fs.html) 与
  [Node 24 Crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html)；
- [Apple `rename(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/rename.2.html)。

## 2. Pi Provider 凭据探针

### 2.1 当前调用路径

`packages/agent/src/pi-process.ts` 通过 `spawn(process.execPath, ...)` 启动 Pi 的 `rpc-entry`，把
`process.env` 完整复制给子进程。当前模型 Provider key 主要由 Pi 自己的 `auth.json` 管理；Web
Search key 则由 `packages/extensions/src/web-tools/credentials.ts` 独立从环境变量或
`credentials.json` 解析。

这意味着阶段 8 之前实际上有两套凭据解析规则：

- Pi：`runtime override → auth.json → environment → models.json`；
- Web tools：`environment → Cinba credentials.json`。

Sync 不能再增加第三套规则。后续必须由 Core 先解析 Local/Sync 来源，再把单个消费者需要的结果交给
`packages/agent` 或 Web tools。

### 2.2 Provider 与环境变量

当前 Pi `0.85.1` 的普通 API-key 映射如下。这里记录的是依赖源码事实，不是承诺第一版管理页面必须
同时展示所有 Provider；Pi 依赖升级时必须重新核对这个表。

| Provider id                                      | 环境变量                        | 备注                                                 |
| ------------------------------------------------ | ------------------------------- | ---------------------------------------------------- |
| `anthropic`                                      | `ANTHROPIC_API_KEY`             | `ANTHROPIC_AUTH_TOKEN` / OAuth 不属于 Shared API key |
| `ant-ling`                                       | `ANT_LING_API_KEY`              | 单 key                                               |
| `azure-openai-responses`                         | `AZURE_OPENAI_API_KEY`          | 还需要 endpoint/resource 等非 secret 本机配置        |
| `openai`                                         | `OPENAI_API_KEY`                | 单 key                                               |
| `nvidia`                                         | `NVIDIA_API_KEY`                | 单 key                                               |
| `deepseek`                                       | `DEEPSEEK_API_KEY`              | 单 key                                               |
| `google`                                         | `GEMINI_API_KEY`                | 单 key                                               |
| `google-vertex`                                  | `GOOGLE_CLOUD_API_KEY`          | 也支持 ADC；project/location 仍是本机配置            |
| `groq`                                           | `GROQ_API_KEY`                  | 单 key                                               |
| `cerebras`                                       | `CEREBRAS_API_KEY`              | 单 key                                               |
| `xai`                                            | `XAI_API_KEY`                   | OAuth/subscription entry 仍必须留在本机              |
| `radius`                                         | `RADIUS_API_KEY`                | OAuth entry 仍必须留在本机                           |
| `openrouter`                                     | `OPENROUTER_API_KEY`            | OAuth 取得的 credential 不同步                       |
| `vercel-ai-gateway`                              | `AI_GATEWAY_API_KEY`            | 单 key                                               |
| `zai`                                            | `ZAI_API_KEY`                   | 单 key                                               |
| `zai-coding-cn`                                  | `ZAI_CODING_CN_API_KEY`         | 单 key                                               |
| `mistral`                                        | `MISTRAL_API_KEY`               | 单 key                                               |
| `minimax`                                        | `MINIMAX_API_KEY`               | 单 key                                               |
| `minimax-cn`                                     | `MINIMAX_CN_API_KEY`            | 单 key                                               |
| `moonshotai` / `moonshotai-cn`                   | `MOONSHOT_API_KEY`              | 两个 Provider 共享同一环境变量                       |
| `huggingface`                                    | `HF_TOKEN`                      | 单 token，按 API key 处理                            |
| `fireworks`                                      | `FIREWORKS_API_KEY`             | 单 key                                               |
| `together`                                       | `TOGETHER_API_KEY`              | 单 key                                               |
| `baseten`                                        | `BASETEN_API_KEY`               | 单 key                                               |
| `opencode` / `opencode-go`                       | `OPENCODE_API_KEY`              | 两个 Provider 共享同一环境变量                       |
| `kimi-coding`                                    | `KIMI_API_KEY`                  | OAuth entry 仍必须留在本机                           |
| `cloudflare-workers-ai`                          | `CLOUDFLARE_API_KEY`            | 还需要 account id                                    |
| `cloudflare-ai-gateway`                          | `CLOUDFLARE_API_KEY`            | 还需要 account id 与 gateway id                      |
| `qwen-token-plan` / `qwen-token-plan-individual` | `QWEN_TOKEN_PLAN_API_KEY`       | 两个 Provider 共享同一环境变量                       |
| `qwen-token-plan-cn`                             | `QWEN_TOKEN_PLAN_CN_API_KEY`    | 单 key                                               |
| `xiaomi`                                         | `XIAOMI_API_KEY`                | 单 key                                               |
| `xiaomi-token-plan-cn`                           | `XIAOMI_TOKEN_PLAN_CN_API_KEY`  | 单 key                                               |
| `xiaomi-token-plan-ams`                          | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | 单 key                                               |
| `xiaomi-token-plan-sgp`                          | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | 单 key                                               |

以下认证不能抽象成第一版“一项 Provider、一份 API key”：

- `amazon-bedrock` 可从 bearer token、AWS profile、IAM key pair、container role 或 web identity
  取得认证，还需要 region 等配置；
- Google Vertex ADC、GitHub Copilot、ChatGPT/Claude subscription 和其它 OAuth token 具有本机或
  自动刷新语义；
- Azure 与 Cloudflare 即使同步主 key，也仍依赖每台 Core 的非 secret 环境配置。第一版不得为了让
  它们看似“零配置同步”而扩大 Shared Settings schema。

### 2.3 认证优先级与冲突

Pi 文档和最小实验一致：

```text
ModelRuntime runtime override
→ auth.json entry（api_key 或 oauth）
→ Provider 环境变量
→ models.json 自定义 Provider key
```

最小实验在临时 `auth.json` 中写入假的 Groq key，同时设置假的 `GROQ_API_KEY`：

- stored credential 覆盖 environment：通过；
- `setRuntimeApiKey()` 覆盖 stored credential：通过；
- 移除 runtime override 后恢复 stored credential：通过；
- `listCredentials()` 只返回 `{ providerId, type }`，不返回 secret：通过。

因此 Shared key 通过环境变量注入时，若同 Provider 在本机 `auth.json` 中存在 `api_key`，Pi 会静默
使用本地值。后续实现必须在启动 Pi 前用 `ModelRuntime.listCredentials()` 的 redacted metadata 报告
冲突并阻止含糊启动。OAuth entry 不删除、不覆盖；Shared default 依赖它时按“需要本机登录”处理。

### 2.4 key 更新只对新 Pi 进程生效

Pi SDK 本身有进程内 `setRuntimeApiKey()`，但 Cinba 使用的是 RPC 子进程。当前 RPC command union
没有登录、重新加载 credential 或设置 runtime key 的命令。CLI 的 `--api-key` 虽能设置 runtime
override，却会把 secret 放进进程参数，不符合设计边界，不能使用。

环境变量在 `spawn()` 时复制，父进程之后更新不会改变已经运行的 Pi。因此结论是：

- Shared key 只通过子进程环境注入；
- key 轮换只影响之后创建的 Pi 进程；
- 不为 Shared key 轮换强杀或自动回收正在运行的会话；
- 本地 `auth.json` 改动当前会走 `markCredentialsStale()` 安全回收路径，这个行为不能误用于 Shared
  key 更新。

另一个必须修正的现状是 `buildSpawnPlan()` 会继承父进程的所有 Provider secret。阶段 8 要先从
`baseEnv` 删除完整的已知 Provider secret 集合，再只为目标模型 Provider 加回一个解析后的 key。
否则 Dev 隔离和“未选 Provider 的 key 不进入子进程”都无法成立。映射应集中在
`packages/agent/src/provider-environment.ts`，不能从 Provider id 猜变量名。

## 3. Desktop 跨 origin 承载探针

### 3.1 当前结构与偏差

计划写的是当前 `BaseWindow` / `WebContentsView` 结构，实际代码是：

```text
BrowserWindow（本地 shell，带 desktop-preload.cjs）
└── WebContentsView（Core Web，无 preload）
```

`WebContentsView` 已设置 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
`desktop:...` IPC handler 还会检查 sender 是否属于 shell 或管理窗口；Core view 不在允许集合内。
这给 Sync view 提供了可复用的隔离基础，但当前 Core 导航保护还不足以直接用于远程管理 origin：

- 使用默认 Electron session，没有把管理员 session 与 Core/local shell 分到独立 partition；
- 只处理主 frame 的 `will-navigate` 和 `window.open`，没有明确处理 redirect 与 subframe；
- 没有 remote session 的 permission request handler；
- 没有下载拦截；
- 任意 `http:` / `https:` 外链都会直接交给 `shell.openExternal()`。

### 3.2 Electron 最小实验

用 Electron `44.2.0` 创建带 `persist:cinba-sync-probe` partition 的 `WebContentsView`，结果：

- view 确实使用指定 session partition；
- `contextIsolation=true`、`nodeIntegration=false`、`sandbox=true`，且没有 preload；
- 同一 partition 内，`sync-one.example.test` 与 `sync-two.example.test` 的同名 host-only、Secure、
  HttpOnly、SameSite=Strict cookie 按 origin/domain 分开；
- 另一 partition 对同一 URL 保存的是另一份 cookie。

结论：Electron 可以安全承载 Sync HTTPS origin，但实现必须显式创建专用持久 partition，不能只依赖
默认 session 中的浏览器同源规则。建议 partition 用内置 SHA-256 对 canonical Sync origin 派生，避免
不同 Sync Server 复用管理员 session，也不把用户输入原样作为 partition 名。

### 3.3 第一版嵌入 policy

阶段 10 必须把以下规则做成纯 policy 并单测：

1. 只接受保存并 canonicalize 后的 `https:` Sync origin；生产模式不接受裸 HTTP、credential URL、
   `javascript:`、`file:` 或自定义 scheme。
2. Sync view 使用 origin 专属的 persistent session、无 preload、Node integration 关闭、context
   isolation 与 sandbox 开启、`webSecurity` 保持默认开启。
3. 对该 session 设置 permission request/check handler，默认拒绝；只在真实功能需要出现后添加最小
   allowlist。
4. `will-frame-navigate`、`will-redirect` 与 `setWindowOpenHandler` 都执行同一 origin policy。主 frame
   只允许留在保存的 Sync origin；新窗口一律不在 Electron 内创建。
5. 外链只在协议和目标通过明确 policy 后交给系统浏览器。不能把远程页面给出的任意 URL 无条件传给
   `shell.openExternal()`。
6. 下载默认拒绝。阶段 6 固定 backup route 后，只允许 Sync origin 发起的那个精确 HTTPS route，
   其它下载拒绝；若这一点无法可靠验收，Backup 操作降级到系统浏览器。
7. Sync view 不加入 Desktop IPC sender allowlist，也不加载 `desktop-preload.cjs`。Core lifecycle IPC
   继续只属于本地 shell。

### 3.4 外部浏览器降级

系统浏览器不是错误恢复后的临时补丁，而是已经明确的安全降级：Desktop 的全局 Sync 入口验证并打开
保存的 HTTPS 管理 URL，管理员 cookie 完全归系统浏览器。如果 Windows 或 macOS 实机验收发现
cookie、下载、SSO/密码管理器或导航隔离有任何不确定性，第一版立即采用这个路径，不复制管理 UI，
也不把 Sync 建成 `CoreProfile`。

## 4. Node 24 文件与加密探针

### 4.1 实验方法

Windows 与 Linux 使用相同的 Node 脚本完成：

1. 创建私有目录、旧 `state.json` 和同目录唯一临时文件；
2. 以 `wx` 打开临时文件，写完整 JSON，执行 file handle `sync()` 并关闭；
3. 重新读取、解析临时文件，再用 `rename()` 覆盖目标；
4. 尝试对父目录执行 `sync()`；
5. 用异步 `scrypt` 派生 32-byte key，以 AES-256-GCM、12-byte random nonce、16-byte tag 加解密；
6. 翻转 ciphertext 一个 bit，确认认证失败。

### 4.2 结果

| 行为                                    | Windows 11 / NTFS             | Linux container | macOS 依据                                           |
| --------------------------------------- | ----------------------------- | --------------- | ---------------------------------------------------- |
| 同目录 rename 覆盖已有目标              | 通过                          | 通过            | Apple `rename(2)` 保证目标始终存在，要求同一文件系统 |
| 临时文件写入、flush、复读校验           | 通过                          | 通过            | Node 24 公共 API                                     |
| 父目录 `fsync`                          | `EPERM`                       | 通过            | POSIX 可用，仍需实机复核                             |
| 请求目录 `0700` / 文件 `0600`           | 读回均为 `0666`，不能表示 ACL | `0700` / `0600` | POSIX mode，应实机复核                               |
| async `scrypt` 32-byte 输出             | 通过                          | 通过            | Node/OpenSSL 跨平台 API                              |
| AES-256-GCM 12-byte nonce / 16-byte tag | 通过                          | 通过            | Node/OpenSSL 跨平台 API                              |
| ciphertext 篡改被拒绝                   | 通过                          | 通过            | AEAD 保证                                            |

Node 官方文档明确说明 Windows 只实现 write permission 的有限切换，不区分 owner/group/other。因此
`mode: 0o600` 在 Windows 不是安全边界。本机默认用户目录 ACL 实测只给当前用户、SYSTEM 和
Administrators 完全控制；现有 `~/.cinba` 继承同样边界。默认 `~/.cinba-sync` 可以依赖这个 ACL，
但自定义 Windows state directory 必须在 CLI/部署文档中提示操作者自行保证 ACL。Node 标准库不能
可靠创建或审计任意 Windows DACL，阶段 0 不因此引入 runtime dependency 或调用本地化的
`icacls` 作为产品逻辑。

Windows 上同目录覆盖在单写者实验中成功，但文件被其它进程、杀毒软件或索引器短暂占用时仍可能返回
`EPERM` / `EACCES` / `EBUSY`。`SyncStore` 已计划串行 mutation；原子替换还应对这些 Windows
瞬时错误做短时间、有上限的 retry。不能先删除旧目标再 rename，因为那会制造无文件窗口，并在失败时
丢掉 last-known-good。

### 4.3 固定的原子写入规则

后续所有 JSON store 和敏感缓存使用同一个原子写 helper：

1. state 目录与目标必须先解析为预期绝对路径；temp 与 target 必须位于同一目录、同一文件系统；
2. temp 名含随机值，以 `wx` 创建，POSIX 请求 `0600`；
3. 写入完整内容，执行 file `sync()`，关闭；
4. 从 temp 复读并走同一严格 parser/schema；
5. bounded retry `rename(temp, target)`，成功前绝不删除 target；
6. POSIX 尝试 flush 父目录；Windows 的目录 `fsync` 失败是可预期的 best-effort，不得把已成功替换
   误报为状态损坏；
7. 失败只清理本次 temp，保留旧 target，并返回可操作错误。

包含明文 key 的 Core cache/temp 必须位于受保护 state directory。Sync Server 的 `state.json` temp
只能包含已经加密的 credential；加密必须发生在构造持久化 document 之前。Backup/restore 同理，
不得先落一份明文 archive 再加密。

### 4.4 加密实现约束

Node 24 内置原语已经足够，阶段 3/4/11 不需要新增 runtime dependency：

- Credential encryption key：`randomBytes(32)` 生成，单独文件保存；
- Credential AEAD：AES-256-GCM，fresh random 12-byte nonce，完整 16-byte authentication tag；
- payload 显式保存 format version、algorithm、nonce、tag、ciphertext，全部二进制字段使用明确编码；
- 管理员密码与迁移密码：异步 `scrypt`，每条记录 fresh random salt（至少 16 bytes），把 N/r/p、
  key length 与格式版本一起保存；具体成本参数在阶段 4/11 通过延迟测试固定；
- 验证 hash 使用 `timingSafeEqual()`，长度先验证；
- 解密或 schema 校验失败即 fail closed，不尝试“修复”成空状态。

## 5. 对后续阶段的约束与计划偏差

1. **Pi 环境变量不能覆盖本地 auth。** `auth.json` 优先于 environment；同步模式必须用 redacted
   credential metadata 检测同 Provider 的本地 API-key 冲突。
2. **运行中 RPC 不能安全换 key。** Pi SDK 有 runtime override，但 RPC 没有对应 command；禁止把
   key 放进 `--api-key`，Shared key 更新只影响新进程。
3. **必须清洗继承环境。** 当前 Pi 子进程继承父进程全部 secret，阶段 8 要删除所有已知 Provider
   secret，再按目标 Provider 注入一个值；Dev 同样执行。
4. **Desktop 现状不是 BaseWindow。** 当前是 `BrowserWindow + WebContentsView`；可以沿用，但 Sync
   必须新增专用 session partition、permission/download/redirect policy。现有 Core policy 不够。
5. **Windows mode 与目录 fsync 不是可移植保证。** Windows 依赖用户目录 ACL，目录 flush
   best-effort；rename 要有 bounded transient retry，不能 unlink-first。
6. **macOS 尚未实机运行探针。** Apple/Node 语义足够固定不依赖 POSIX-only 假设的设计，但阶段
   10/12 的 Mac 实机验收仍是发布门槛。
7. **不需要新增 runtime dependency。** Provider 映射、origin hash、scrypt、AEAD、原子写入和
   Electron session policy 都能使用当前依赖与 Node/Electron 内置 API 实现。

## 6. 阶段 0 完成判断

- Provider 映射、认证优先级和进程更新边界已有当前依赖源码、文档与最小实验三重证据；
- Desktop 嵌入可行，所需加固和系统浏览器降级条件已明确；
- 文件与加密实现已剔除 Windows 不支持的 POSIX mode/目录 fsync 假设；
- 没有新增 runtime dependency，没有扩大第一版范围，没有修改产品代码。

因此阶段 0 可以结束。下一步应从阶段 1 的纯内部重构开始，先保持 Local 可见行为不变；不能跳到
Sync Server、网络协议或 UI。
