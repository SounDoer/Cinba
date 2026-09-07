# 远程接入调研：Pi 的内建能力与同类项目做法

日期：2026-09-07
背景：阶段 3b-1 完成后、3b-2 开工前的一次调研。目的是在写设计文档之前，先看清楚
「哪些问题 Pi 已经给了工具」和「别人是怎么解的」。

来源：Pi 包内文档与类型定义（版本严格一致，优先于网页）、[paseo.sh](https://paseo.sh/) 的
公开文档、[pi.dev/packages](https://pi.dev/packages) 的包列表。

---

## 1. ⭐ Pi 的对话框支持超时，且由 agent 侧自动兑现

**这是本次最有价值的发现，它解掉了 3b-2 预想中最硬的一块。**

`docs/rpc.md:1193`：

> If a dialog method includes a `timeout` field, the agent-side will auto-resolve with a
> default value when the timeout expires. **The client does not need to track timeouts.**

对应的扩展 API（`dist/core/extensions/types.d.ts:36-41, 72`）：

```ts
confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>

interface ExtensionUIDialogOptions {
  /** AbortSignal to programmatically dismiss the dialog. */
  signal?: AbortSignal;
  /** Timeout in milliseconds. Dialog auto-dismisses with live countdown display. */
  timeout?: number;
}
```

### 为什么这件事重要

3b-2 预想的困境是：

```
你在外面，模型要改文件 → Pi 停下来问 → 你进隧道断线了
  → Pi 不知道你断了，它只知道「客户端还没回话」
  → 永远阻塞
```

有了 `timeout`，这条路变成：

```
超时 → Pi 自己收摊 → confirm 返回 falsy → 权限门 return { block: true }
```

**而且默认方向就是对的**：超时等于没人批准，等于拦截，天然 fail-closed，与
`docs/specs/2026-09-06-cinba-design.md` 第 9 节确立的原则一致。

`AbortSignal` 则提供了另一种可能：客户端重连后撤掉旧对话框重新问。

### 待实测

- **超时后 `confirm()` 究竟返回什么**（`false`？还是 reject？）。文档对 `select` 说的是
  auto-resolve 成 `undefined`；`confirm` 的返回类型是 `Promise<boolean>`，未明确。
  本项目的权限门写的是 `if (!allowed) return { block: true }`，`false` 与 `undefined`
  都会走到拦截，但仍应实测确认不是抛异常。
- 超时期间 RPC 客户端会收到什么（有没有额外事件通知「这个请求已经作废」）。若没有，
  界面上那张「待批准」卡片可能会一直挂着，需要客户端自己收拾。

### 可以现在就做的

给权限门加上 `timeout`。本机场景用不太上，但它是远程的前提，且加了没有坏处——
**唯一要想清楚的是超时时长**。太短会在你正常思考时打断，太长则失去意义。

---

## 2. Paseo 的安全模型（同类项目中与本项目方向最接近的一个）

[Paseo](https://paseo.sh/) 是自托管的「coding agent 控制面」，支持 Claude Code、Codex、
OpenCode、**Pi** 等 34+ 个 provider，桌面 / 网页 / 移动端都能连。**它做的正是本项目 3b-2
想做的事**，且已在真实用户手上运行。

### 架构与本项目一致

> "you can run the daemon headless and use any client to connect.
> The desktop app just bundles the daemon with a UI."

守护进程跑在本机、客户端连上来——**与我们阶段 3a 选的形态 B 完全同构**（`core-server`
独立进程，`desktop` 只是个壳）。这算是对那次架构选择的一个旁证。

### 认证：配对式公钥握手，不是共享令牌

```
daemon 生成一对持久的 ECDH 密钥，存在本机
配对二维码 / 链接里装的是 daemon 的公钥
客户端与 daemon 用 Curve25519 做握手
```

**这比「二维码里放一串令牌」强一档**：令牌是共享秘密，泄露即失守；公钥握手过程中不传秘密。

可选叠加密码：`Authorization: Bearer <password>`。

### 外向中继：连端口都不用开

```
daemon 主动向外连中继服务器（不监听任何入站端口）
客户端在中继处与它会合
两端 NaCl box 端到端加密（Curve25519 + XSalsa20-Poly1305）
```

> "the relay is designed to be untrusted... Only the paired endpoints can open the NaCl box payloads."

中继读不到内容、改不了内容。**这比 Tailscale 更进一步——连私有网络都不需要。**

代价是依赖一个第三方中继服务（可用性、隐私上的信任假设不同）。

### 其余几条与本项目已有判断一致

| Paseo 的建议 | 本项目的对应记录 |
|---|---|
| 用 Tailscale 时：绑到 VPN 地址**并且**设密码 | 已提出「Tailscale + 应用级令牌」纵深防御 |
| **不要绑 `0.0.0.0`** | 3a 计划里写死的铁律，重复出现在两处 |

### ⚠️ 它没有解决的

**Paseo 的安全文档完全没提权限确认、审批流程、以及断线时如何处理。**

所以这确实是个公开资料里没有标准答案的问题——只不过 Pi 自己给了工具（见第 1 节）。

---

## 3. Pi 包生态里值得留意的

来自 [pi.dev/packages](https://pi.dev/packages)。npm 上有 629 个项目依赖 `pi-coding-agent`。

| 包 | 做什么 | 与本项目的关系 |
|---|---|---|
| **`pi-web-ui`** | **给 Pi 做的网页聊天界面** | 与阶段 3b-1 同类。npm 页面 403 抓不到，未细看 |
| `@gotgenes/pi-permission-system` | 权限强制扩展 | 与我们的权限门同类 |
| `@zeldrisho/pi-gate` | 按用户提供的 JSON 配置拦截 / 确认 bash 命令 | **比我们细一档**：我们是「只读放行、其余全问」，它可按规则配置。等嫌确认太烦时值得参考 |
| `cc-safety-net` | 拦破坏性命令与密钥文件访问 | 同上 |
| `pi-memory` / `pi-hermes-memory` | 持久记忆 + 全文检索 | 阶段 4 之后可能有用 |
| `pi-subagents` / `@luminascale/pi-shepherd` | 子 agent 委派与编排 | 远期 |
| `pi-mcp-adapter` | MCP 适配 | 远期 |

**`pi-web-ui` 的存在说明这条路有人走通过**，不是我们在硬造。

---

## 4. 仍然空白：怎么知道「它在等你批准」

Paseo 未提通知机制，Pi 的包列表里也没有推送相关的包。

Pi 自带示例有 `examples/extensions/notify.ts`，但那是 agent 主动通知用户的机制
（对应 RPC 里的 `notify` 广播式 UI 请求），**不是推送到手机**。

这可能说明两件事之一：

1. 真正需要的人不多，大家实际用法是「想起来了打开看看」
2. 它确实是个缺口，只是还没人做

**这个问题的答案不在调研里，在实际使用中。** 建议先用一段时间再判断要不要做。

---

## 4.5 前提更新：用户有自己的 VPS

调研之后补充的信息，它改变了 3b-2 的选项空间。

### 先分清两件独立的事

「中继」与「认证」经常被混在一起，其实可以自由组合：

```
中继解决：  怎么把两台都在路由器后面的机器接上
认证解决：  怎么确认连过来的是本人
```

Paseo 用的是「自家中继 + 公钥配对」，但「自己的 VPS + 简单令牌」同样成立。

### 有 VPS 之后的三条路

**A. 自己写中继服务** —— **不建议**。要写网络转发、鉴权、连接管理、异常处理，
而这类代码写错了不报错，只是悄悄留个洞。这是 Paseo 作为产品必须做的事，不是自用工具的复杂度。

**B. SSH 反向隧道 + Caddy**

```bash
# 家里电脑（往外连，所以家里一个端口都不用开）
autossh -M 0 -N -R 8080:127.0.0.1:4517 user@vps
```

VPS 上 Caddy 两行配置负责 HTTPS 与证书：

```
cinba.example.com { reverse_proxy 127.0.0.1:8080 }
```

- 不写任何网络代码，SSH 与 Caddy 都是久经考验的东西
- **手机什么都不用装，任何浏览器打开网址即可**
- 代价：服务**真正暴露在公网**，认证成为唯一防线；流量全部经过 VPS

**C. 自建 Headscale**（Tailscale 协调服务器的开源版）

- 协调服务器只是「电话簿」，分发设备身份与公钥；**数据是设备点对点直连，不经过 VPS**
- 外面完全看不到你的服务，攻击面最小
- 代价：每台设备都要装 Tailscale 客户端并登录

### 关键判断：自己的 VPS 让端到端加密的必要性下降

Paseo 必须做 NaCl box 端到端加密，是因为**他们的中继是给别人用的服务**——用户凭什么相信
运营方不看内容。

而自己的 VPS 上，端到端加密防的是自己。到 VPS 的 TLS 已经够了。
「万一 VPS 被攻破」是真实场景，多一层是纵深防御，但对自用工具属于过度设计——
真被攻破了，攻击者能做的事远不止看聊天记录。

### 三条路的对比

| | 手机要装东西 | 公网暴露 | 数据经过 VPS | 要写代码 |
|---|---|---|---|---|
| 官方 Tailscale | 要 | 否 | 否 | 几乎不用 |
| B：SSH 隧道 + Caddy | **不用** | **是** | 是 | 不用 |
| C：自建 Headscale | 要 | 否 | 否 | 不用 |
| A：自写中继 | 不用 | 是 | 是 | **要** |

### 结论

1. **不需要自己写中继。** 现成工具（SSH / Caddy / Tailscale）覆盖了全部需求。
2. **官方 Tailscale 是最简起点**——连 VPS 都用不上，3b-2 能最快跑通远程链路本身。
3. **VPS 的不可替代之处在 B**：提供一个公网入口，让「临时用别人的设备也能打开」成立。
   若这个场景不重要，C/Tailscale 明显更划算——不暴露在公网等于排除掉一整类攻击。
4. **两条路对 `core-server` 几乎没有区别**，只是监听哪个地址不同。可以先做 Tailscale
   验证链路，之后再加 VPS 入口，不必二选一。
5. **值得从 Paseo 吸收的两点**（无论选哪条）：二维码配对（电脑显示、手机扫，
   远好过手打一长串）；不要每次连接都在网络上明文重传共享秘密。

**若选 B，认证不能敷衍**：这个服务的权限是完整 shell，而公网上的端口扫描是全天候自动进行的。
至少两层——反向代理一层 + 应用层令牌一层。

## 5. 对 3b-2 的具体影响

1. **权限门加 `timeout`**（第 1 节）。不必等 3b-2，现在就能做；需先实测超时后的返回值。
2. **通道方案有三条现成的路，都不需要自写中继**（第 4.5 节）：
   - 官方 Tailscale —— 最简起点，连 VPS 都用不上
   - 自建 Headscale —— 同上但设备名单在自己手里
   - SSH 反向隧道 + Caddy —— 唯一能做到「手机什么都不装」的，代价是真的暴露在公网
3. **认证与通道是两件独立的事**，不要绑在一起选。无论走哪条通道，
   都值得吸收 Paseo 的两点：二维码配对；不要每次连接明文重传共享秘密。
4. **「不绑 `0.0.0.0`」这条已被独立来源印证**，继续作为硬性约束。
   注意：走 B（SSH 隧道）时服务仍然只监听 `127.0.0.1`——隧道是从本机接出去的，
   不需要放宽绑定地址。这条约束在三种方案下都不必破。
5. **动手前值得再看一眼 `pi-web-ui` 与那三个权限扩展的源码**——尤其它们如何处理超时与
   多客户端并发确认。

---

## 6. 本次调研的方法说明

先查 Pi 包内的文档与类型定义（版本与安装版严格一致），再看外部项目。

**顺序很重要**：第 1 节那条是从本地 `docs/rpc.md` 和 `.d.ts` 里读出来的，而它比所有外部
资料都更直接地解决了我们的问题。**包里自带的东西比网上搜到的更可靠，也更容易被忽略**——
阶段 1a 到 3b-1 期间，我们已经两次在 Pi 自带示例里发现该早点看的东西：

- 阶段 2：官方 TUI 示例的渲染方式对中文不安全（抄了它的毛病）
- 2026-09-07：官方 `permission-gate.ts` 示例在无界面时 fail-closed，而我们写成了 fail-open（没抄到它的优点）

**结论：参照实现要读，但要带着判断读。** 它既不是标准答案，也不是可以忽略的东西。
