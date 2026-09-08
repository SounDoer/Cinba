// Phase 0 protocol probe: print every event Pi's RPC mode emits, verbatim.
//
// Usage: node scripts/probe.ts ["something to ask"]

import { spawn } from "node:child_process";

const prompt = process.argv[2] ?? "Say in one sentence what you can do.";

// On Windows pi is really pi.cmd, and Node 18.20+ refuses to spawn .cmd/.bat
// directly for security reasons (EINVAL), so the shell is explicit here. Adding
// shell does no harm on Linux or macOS.
//
// --provider deepseek is temporary: settings.json defaults the provider to
// anthropic while we only have a DeepSeek key. Phase 1 moves this decision into
// core-host, where it is managed in one place.
const pi = spawn("pi", ["--mode", "rpc", "--provider", "deepseek"], {
  stdio: ["pipe", "pipe", "inherit"], // stderr passes straight to our terminal so errors are visible
  shell: true,
});

// Pi's docs are explicit: split on \n only, never with a general-purpose line
// reader (those treat Unicode line separators as newlines too and shred the
// content). So we keep our own buffer and split by hand.
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
    console.log(`\n-- non-JSON output --\n${line}`);
  }
}

pi.on("error", (err) => {
  console.error("failed to start pi:", err.message);
});

pi.on("exit", (code) => {
  console.log(`\npi exited, code=${code}`);
});

// Send the first prompt. Note the trailing \n: JSONL separates records with it, and without it Pi waits forever.
pi.stdin.write(JSON.stringify({ type: "prompt", message: prompt }) + "\n");
