// The phase 1a end-to-end check: the agent package, the contract and the permission
// gate strung together.
//
// Usage: node scripts/repl.ts "your question"

import { createInterface } from "node:readline/promises";
import { PiClient, StdioTransport, startPi } from "@cinba/agent";

const child = startPi();

// startPi leaves stderr to the caller; forward it to the terminal as is.
child.stderr?.setEncoding("utf8");
child.stderr?.on("data", (chunk: string) => process.stderr.write(chunk));

const client = new PiClient(new StdioTransport(child));

const rl = createInterface({ input: process.stdin, output: process.stdout });

// Permission confirmation: whatever the core asks, we ask the user in the terminal
client.onUiRequest(async (request) => {
  if (request.method === "confirm") {
    console.log(`\n⚠️  ${String(request.title ?? "confirmation needed")}`);
    console.log(String(request.message ?? ""));
    const answer = await rl.question("Allow? (y/N) ");
    return { confirmed: answer.trim().toLowerCase() === "y" };
  }
  if (request.method === "notify") {
    console.log(`[notice] ${String(request.message ?? "")}`);
    return { cancelled: true };
  }
  return { cancelled: true };
});

client.onEvent((event) => {
  if (event.type === "tool_execution_start") {
    console.log(`\n🔧 ${String(event.toolName)}`);
  }
  if (event.type === "agent_settled") {
    console.log("\n--- done ---");
    void client.close().then(() => rl.close());
  }
  if (event.type === "message_end") {
    const message = event.message as { role?: string; content?: unknown } | undefined;
    if (message?.role === "assistant") {
      console.log(`\n${JSON.stringify(message.content)}`);
    }
  }
});

await client.prompt(process.argv[2] ?? "hello");
