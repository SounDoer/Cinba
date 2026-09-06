# 阶段 0：协议探针 实施计划

**目标：** 让 Pi 的 RPC 模式跑起来，把它吐出的每一条 JSONL 事件原样打印，搞清楚协议里到底有什么。

**架构：** 一个几十行的 Node 脚本，spawn `pi --mode rpc` 作为子进程，往 stdin 写一条 prompt，把 stdout 的 JSONL 逐条解析并美化打印。

**技术栈：** Node 24（原生支持直接执行 `.ts`，无需构建）、`@earendil-works/pi-coding-agent`。

**关于测试：** 本阶段不写单元测试。阶段 0 的目的是**发现**——我们不知道 Pi 会吐什么，因此写不出"期望值"。验证方式是运行脚本并肉眼核对输出。阶段 1 开始有明确契约后转入正常的测试驱动。

---

## 前置知识

- **RPC 模式启动命令：** `pi --mode rpc`
- **stdin 发送格式：** 每条一行 JSON + `\n`，例如 `{"type":"prompt","message":"你好"}`
- **stdout 接收格式：** JSONL，**必须只按 `\n` 切分**。Pi 文档明确警告不要用会把 Unicode 分隔符当换行的通用行读取器，否则会把内容切碎。
- **已知事件类型（部分）：** `agent_start`、`message_update`（含 `assistantMessageEvent` 流式增量）、`tool_execution_start`、`bash_execution_update`
- **已知命令类型（部分）：** `prompt`、`abort`、`steer`、`clear_queue`

---

## Task 1：安装 Pi 并完成认证

**这一步由你手动执行**（涉及凭据，需要你自己操作）。

- [ ] **Step 1: 全局安装 Pi**

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` 是 Pi 官方推荐的装法，出于供应链安全考虑，跳过依赖包的安装脚本。

- [ ] **Step 2: 验证安装**

```bash
pi --version
```

期望：打印出版本号。若提示 command not found，检查 npm 全局 bin 目录是否在 PATH 里（`npm bin -g` 可查看）。

- [ ] **Step 3: 认证（二选一）**

方式 A —— 用已有订阅（有 Claude Pro / Max 或 ChatGPT Plus 就选这个，最省事）：

```bash
pi
```

进入交互界面后输入 `/login`，按提示走浏览器授权，完成后 `Ctrl+C` 退出。

方式 B —— 用 API key：

```bash
export ANTHROPIC_API_KEY=sk-ant-你的key
```

要长期生效需写进 shell 配置文件。**不要把 key 提交进仓库。**

- [ ] **Step 4: 验证认证可用**

```bash
pi -p "回复一个字：好"
```

期望：终端打印出模型的回复。这一步通过，说明 Pi 已经能正常调模型了。

---

## Task 2：初始化仓库根

**Files:**
- Create: `package.json`

- [ ] **Step 1: 创建根 package.json**

```json
{
  "name": "cinba",
  "private": true,
  "type": "module",
  "version": "0.0.0"
}
```

`"type": "module"` 让 Node 用 ESM 方式解析我们的 `.ts` 文件。`"private": true` 防止误发布。workspaces 字段等阶段 1 建包时再加，现在不需要。

- [ ] **Step 2: 提交**

```bash
git add package.json
git commit -m "chore: 初始化仓库根"
```

---

## Task 3：写协议探针

**Files:**
- Create: `scripts/probe.ts`

- [ ] **Step 1: 写探针脚本**

```typescript
// 阶段 0 协议探针：把 Pi RPC 模式吐出的每一条事件原样打印出来。
// 用法：node scripts/probe.ts ["要问的话"]

import { spawn } from "node:child_process";

const prompt = process.argv[2] ?? "用一句话说明你能做什么。";

const pi = spawn("pi", ["--mode", "rpc"], {
  stdio: ["pipe", "pipe", "inherit"], // stderr 直接透传到我们的终端，方便看报错
});

// Pi 文档要求：只按 \n 切分，不要用通用行读取器。
// 所以这里自己维护缓冲区，手工切行。
let buffer = "";

pi.stdout.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  let index: number;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() !== "") printEvent(line);
  }
});

function printEvent(line: string): void {
  try {
    const event = JSON.parse(line);
    console.log(`\n── ${event.type} ──`);
    console.log(JSON.stringify(event, null, 2));
  } catch {
    console.log(`\n── 非 JSON 输出 ──\n${line}`);
  }
}

pi.on("exit", (code) => {
  console.log(`\npi 进程退出，code=${code}`);
});

// 发出第一条 prompt
pi.stdin.write(JSON.stringify({ type: "prompt", message: prompt }) + "\n");
```

- [ ] **Step 2: 运行**

```bash
node scripts/probe.ts "你好"
```

期望：屏幕上出现一连串 `── 事件名 ──` 加缩进 JSON。至少应该看到 `agent_start` 和若干 `message_update`。

若脚本跑完不自动退出，`Ctrl+C` 结束——这本身也是一条发现（说明 RPC 模式是常驻的，需要显式关闭）。

- [ ] **Step 3: 提交**

```bash
git add scripts/probe.ts
git commit -m "feat: 阶段0 协议探针"
```

---

## Task 4：让探针触发工具调用

目的是看清工具调用和权限确认的事件长什么样——这是 GUI 最关键、也是文档里没写清的部分。

- [ ] **Step 1: 用一个会触发 bash 工具的问题跑探针**

```bash
node scripts/probe.ts "运行 ls 命令，告诉我当前目录下有什么"
```

期望：除了 `message_update`，还应出现 `tool_execution_start`（含 `toolName`、`args`）和 `bash_execution_update`。

- [ ] **Step 2: 观察是否出现权限确认**

重点看：Pi 在执行 bash 前，**有没有**往 stdout 发一条请求授权的事件、并等待我们回话？

- 若**有** —— 记下它的完整 JSON 形状，以及我们该回什么。这是 GUI 必须实现的交互。
- 若**没有**（直接就执行了）—— 说明 RPC 模式默认放行工具，权限门要靠自己写 extension 实现（`ctx.ui.confirm()`）。这会影响阶段 1 的设计。

- [ ] **Step 3: 用一个会写文件的问题再跑一次**

```bash
node scripts/probe.ts "在当前目录创建一个 hello.txt，内容是 hi"
```

期望：出现 `write` 或 `edit` 相关的工具事件。对比它和 bash 事件的结构差异。

- [ ] **Step 4: 清理测试产生的文件**

```bash
rm -f hello.txt
```

---

## Task 5：记录发现

**Files:**
- Create: `docs/notes/2026-09-06-rpc-protocol-findings.md`

- [ ] **Step 1: 把观察到的事实写下来**

至少回答这几个问题：

1. 实际观察到了哪些事件类型？各自的 JSON 形状是什么？
2. 一次完整对话的事件顺序是怎样的？
3. 工具调用前有没有权限确认握手？如果有，格式是什么？
4. RPC 进程在一次 prompt 结束后是退出还是常驻？
5. 有没有明确的"本轮结束"信号？GUI 要靠什么判断可以再次输入？

问题 3 和 5 直接决定阶段 1 的 `core-client` 怎么设计，务必写清楚。

- [ ] **Step 2: 提交**

```bash
git add docs/notes/
git commit -m "docs: RPC 协议实测发现"
```

---

## Task 6：回填设计文档

- [ ] **Step 1: 更新设计文档第 8 节**

打开 `docs/specs/2026-09-06-cinba-design.md`，把第 8 节里"RPC 模式 vs JSON event stream 模式该用哪个"这条未知项，改成实测结论。若发现架构需要调整，一并改掉相关章节。

- [ ] **Step 2: 提交**

```bash
git add docs/specs/
git commit -m "docs: 用实测结果回填设计文档的未知项"
```

---

## 阶段 0 完成标准

- [ ] `pi -p "..."` 能正常返回模型回复
- [ ] `node scripts/probe.ts` 能打印出结构化事件流
- [ ] 已观察到工具调用事件，并弄清有无权限确认握手
- [ ] `docs/notes/` 下有一份实测记录，回答了全部 5 个问题
- [ ] 设计文档第 8 节的未知项已被实测结论替换
