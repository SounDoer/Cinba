// Watch a session on the core service: connect, print whatever arrives, send nothing.
//
// Use one: checking multiple clients (the GUI in use, this one looking on).
// Use two: a probe for debugging the protocol later, same idea as
// scripts/probe.ts.
//
// Usage: node scripts/watch.ts

import { CoreClient } from "@cinba/core-client";

const SERVER_URL = "ws://127.0.0.1:4517/ws";
let exiting = false;

const client = new CoreClient(SERVER_URL, {
  onConnectionChanged: (state) => {
    if (state === "disconnected" && !exiting) {
      console.error("the core service went away");
      process.exit(1);
    }
  },
  onError: () => {
    console.error(`cannot reach ${SERVER_URL} - is the core service running?`);
    process.exit(1);
  },
  onSnapshot: ({ snapshot, cwd }) => {
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
});

process.once("SIGINT", () => {
  exiting = true;
  client.close();
  process.exit(0);
});

console.log("watching, Ctrl+C to exit");
