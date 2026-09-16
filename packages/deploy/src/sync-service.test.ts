import assert from "node:assert/strict";
import test from "node:test";
import { refreshSyncService } from "./sync-service.ts";

test("an inactive Sync service is not enabled by a Core release", async () => {
  const calls: string[][] = [];
  await refreshSyncService(async (_command, args) => {
    calls.push(args);
    return { stdout: "inactive\n" };
  });
  assert.deepEqual(calls, [
    ["--user", "show", "--property=ActiveState", "--value", "cinba-sync.service"],
  ]);
});

test("an active Sync service restarts onto current and is verified", async () => {
  const calls: string[][] = [];
  const states = ["active\n", "", "active\n"];
  await refreshSyncService(
    async (_command, args) => {
      calls.push(args);
      return { stdout: states.shift()! };
    },
    { fetcher: async () => Response.json({ status: "ok" }) },
  );
  assert.deepEqual(calls, [
    ["--user", "show", "--property=ActiveState", "--value", "cinba-sync.service"],
    ["--user", "restart", "cinba-sync.service"],
    ["--user", "show", "--property=ActiveState", "--value", "cinba-sync.service"],
  ]);
});

test("a failed Sync restart fails release verification", async () => {
  const states = ["active\n", "", "failed\n"];
  await assert.rejects(
    refreshSyncService(async () => ({ stdout: states.shift()! }), {
      fetcher: async () => Response.json({ status: "ok" }),
    }),
    /did not become active/,
  );
});

test("an active Sync service must pass its loopback health check", async () => {
  const states = ["active\n", "", "active\n"];
  let time = 0;
  await assert.rejects(
    refreshSyncService(async () => ({ stdout: states.shift()! }), {
      fetcher: async () => new Response(null, { status: 503 }),
      now: () => time,
      sleep: async () => {
        time = 30_000;
      },
    }),
    /health check/,
  );
});
