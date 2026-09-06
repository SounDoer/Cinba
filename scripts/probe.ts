// 阶段 0 协议探针：把 Pi RPC 模式吐出的每一条事件原样打印出来。
//
// 用法：node scripts/probe.ts ["要问的话"]

import { spawn } from "node:child_process";

const prompt = process.argv[2] ?? "用一句话说明你能做什么。";

// Windows 上 pi 实际是 pi.cmd，而 Node 18.20+ 出于安全考虑禁止直接 spawn .cmd/.bat
// （会报 EINVAL），必须显式走 shell。Linux/macOS 上加 shell 也无妨。
//
// --provider deepseek 是临时的：settings.json 里的默认 provider 是 anthropic，
// 而我们只有 DeepSeek 的 key。阶段 1 这个决定会搬进 core-host 统一管理。
const pi = spawn("pi", ["--mode", "rpc", "--provider", "deepseek"], {
  stdio: ["pipe", "pipe", "inherit"], // stderr 直接透传到我们的终端，方便看报错
  shell: true,
});

// Pi 文档明确要求：只按 \n 切分，不要用通用行读取器
// （那类读取器会把 Unicode 行分隔符也当换行，从而把内容切碎）。
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

pi.on("error", (err) => {
  console.error("启动 pi 失败：", err.message);
});

pi.on("exit", (code) => {
  console.log(`\npi 进程退出，code=${code}`);
});

// 发出第一条 prompt。注意结尾的 \n —— JSONL 靠它分隔记录，漏了 Pi 会一直等下去。
pi.stdin.write(JSON.stringify({ type: "prompt", message: prompt }) + "\n");
