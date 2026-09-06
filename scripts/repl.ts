// 阶段 1a 的端到端验证：把 core-host + core-client + 权限门串起来。
//
// 用法：node scripts/repl.ts "你的问题"

import { createInterface } from "node:readline/promises";
import { startCore } from "@cinba/core-host";
import { CoreClient, StdioTransport } from "@cinba/core-client";

const child = startCore();

// startCore 把 stderr 交给调用方处理，这里原样转到终端。
child.stderr?.setEncoding("utf8");
child.stderr?.on("data", (chunk: string) => process.stderr.write(chunk));

const client = new CoreClient(new StdioTransport(child));

const rl = createInterface({ input: process.stdin, output: process.stdout });

// 权限确认：核心问什么，我们就在终端问用户
client.onUiRequest(async (request) => {
  if (request.method === "confirm") {
    console.log(`\n⚠️  ${String(request.title ?? "需要确认")}`);
    console.log(String(request.message ?? ""));
    const answer = await rl.question("允许？(y/N) ");
    return { confirmed: answer.trim().toLowerCase() === "y" };
  }
  if (request.method === "notify") {
    console.log(`[通知] ${String(request.message ?? "")}`);
    return { cancelled: true };
  }
  return { cancelled: true };
});

client.onEvent((event) => {
  if (event.type === "tool_execution_start") {
    console.log(`\n🔧 ${String(event.toolName)}`);
  }
  if (event.type === "agent_settled") {
    console.log("\n─── 完成 ───");
    void client.close().then(() => rl.close());
  }
  if (event.type === "message_end") {
    const message = event.message as { role?: string; content?: unknown } | undefined;
    if (message?.role === "assistant") {
      console.log(`\n${JSON.stringify(message.content)}`);
    }
  }
});

await client.prompt(process.argv[2] ?? "你好");
