import { test } from "node:test";
import assert from "node:assert/strict";
import { stopCoreService } from "./core-service.ts";

test("stopping the service waits for its drain and confirms it is inactive", async () => {
  const calls: string[][] = [];
  await stopCoreService(async (command, args) => {
    calls.push([command, ...args]);
    return { stdout: args.includes("show") ? "inactive\n" : "" };
  });

  assert.deepEqual(calls, [
    ["systemctl", "--user", "stop", "cinba.service"],
    ["systemctl", "--user", "show", "--property=ActiveState", "--value", "cinba.service"],
  ]);
});

test("a service that remains active stops the deployment", async () => {
  await assert.rejects(
    stopCoreService(async () => ({ stdout: "active\n" })),
    /did not become inactive/,
  );
});
