import assert from "node:assert/strict";
import test from "node:test";
import { beginForegroundUninstall } from "./product-uninstall.ts";

function recorder() {
  const calls: unknown[] = [];
  return {
    calls,
    dependencies: {
      processIsAlive: () => true,
      stopProduct: async (options?: { stopDesktop?: boolean }) => {
        calls.push(["stop", options]);
      },
      launchHelper: async (options: { purge: boolean; blockingProcessId?: number }) => {
        calls.push(["launch", options]);
      },
    },
  };
}

test("uninstall from Desktop leaves the requesting Desktop running for the helper to await", async () => {
  const { calls, dependencies } = recorder();
  await beginForegroundUninstall(
    { surface: "desktop", blockingProcessId: 123, purge: false },
    dependencies,
  );
  assert.deepEqual(calls, [
    ["stop", { stopDesktop: false }],
    ["launch", { purge: false, blockingProcessId: 123 }],
  ]);
});

test("uninstall from TUI stops Desktop and hands purge to a helper awaiting the TUI launcher", async () => {
  const { calls, dependencies } = recorder();
  await beginForegroundUninstall(
    { surface: "tui", blockingProcessId: 456, purge: true },
    dependencies,
  );
  assert.deepEqual(calls, [
    ["stop", { stopDesktop: true }],
    ["launch", { purge: true, blockingProcessId: 456 }],
  ]);
});

test("active Core work refuses the uninstall before any helper starts", async () => {
  const { calls, dependencies } = recorder();
  await assert.rejects(
    beginForegroundUninstall(
      { surface: "desktop", blockingProcessId: 123, purge: true },
      {
        ...dependencies,
        stopProduct: async () => {
          throw new Error("Cinba cannot be uninstalled while the local Core has active work");
        },
      },
    ),
    /active work/,
  );
  assert.deepEqual(calls, []);
});

test("a requesting process that already exited cannot start an uninstall", async () => {
  const { calls, dependencies } = recorder();
  await assert.rejects(
    beginForegroundUninstall(
      { surface: "tui", blockingProcessId: 123, purge: false },
      { ...dependencies, processIsAlive: () => false },
    ),
    /not running/,
  );
  assert.deepEqual(calls, []);
});
