// Watch a session on the core service: connect, print whatever arrives, send nothing.
//
// Use one: checking multiple clients (the GUI in use, this one looking on).
// Use two: a probe for debugging the protocol later, same idea as
// scripts/probe.ts.
//
// Usage: node scripts/watch.ts

import { RemoteSession } from "@cinba/contract";

const socket = new WebSocket("ws://127.0.0.1:4517/ws");

socket.addEventListener("error", () => {
  console.error("cannot reach ws://127.0.0.1:4517/ws - is the core service running?");
  process.exit(1);
});

new RemoteSession(socket, {
  onSnapshot: (snapshot, cwd) => {
    console.log(
      `[snapshot] cwd=${cwd} entries=${snapshot.entries.length} ` +
        `tokens=${snapshot.totalTokens} busy=${snapshot.busy}`,
    );
  },
  onActions: (actions) => {
    for (const action of actions) {
      if (action.type === "text_appended") {
        process.stdout.write(action.text);
      } else {
        console.log(`\n[action] ${JSON.stringify(action).slice(0, 160)}`);
      }
    }
  },
  onReset: (cwd) => console.log(`\n[reset] cwd=${cwd}`),
});

console.log("watching, Ctrl+C to exit");
