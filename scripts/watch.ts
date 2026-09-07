// 旁观 core-server 的会话：连上去，把收到的东西打出来，不发任何命令。
//
// 用途一：验证多客户端（GUI 在用，这个在旁边看）。
// 用途二：以后调试协议时的探针，跟 scripts/probe.ts 一个性质。
//
// 用法：node scripts/watch.ts

import { RemoteSession } from "@cinba/core-client";

const socket = new WebSocket("ws://127.0.0.1:4517");

socket.addEventListener("error", () => {
  console.error("连不上 ws://127.0.0.1:4517，core-server 起了吗？");
  process.exit(1);
});

new RemoteSession(socket, {
  onSnapshot: (snapshot, cwd) => {
    console.log(
      `[快照] 工作目录=${cwd} 条目=${snapshot.entries.length} ` +
        `tokens=${snapshot.totalTokens} busy=${snapshot.busy}`,
    );
  },
  onActions: (actions) => {
    for (const action of actions) {
      if (action.type === "text_appended") {
        process.stdout.write(action.text);
      } else {
        console.log(`\n[动作] ${JSON.stringify(action).slice(0, 160)}`);
      }
    }
  },
  onReset: (cwd) => console.log(`\n[重置] 工作目录=${cwd}`),
});

console.log("旁观中，Ctrl+C 退出");
