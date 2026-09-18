import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createManagedSyncControl,
  inspectManagedSyncControl,
  removeManagedSyncControl,
  stopManagedSyncControl,
  waitForManagedSyncExit,
} from "./sync-control.ts";

function config(root: string) {
  return {
    baseUrl: "http://127.0.0.1:4518/",
    runtimePath: join(root, "sync-runtime.json"),
    controlPath: join(root, "sync-control.json"),
  };
}

test("matching private records and authenticated status establish Sync ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-sync-control-"));
  try {
    const control = config(root);
    await createManagedSyncControl({ config: control, pid: 123, token: "secret" });
    assert.deepEqual(
      await inspectManagedSyncControl({
        config: control,
        probeHealth: async () => true,
        processIsAlive: () => true,
        requestStatus: async (_baseUrl, token) =>
          token === "secret"
            ? {
                status: "ok",
                pid: 123,
                activeRequestCount: 0,
                safeToStop: true,
                draining: false,
              }
            : undefined,
      }),
      {
        running: true,
        managed: true,
        pid: 123,
        activeRequestCount: 0,
        safeToStop: true,
        draining: false,
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale or mismatched records can never request a Sync stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-sync-control-stale-"));
  let stops = 0;
  try {
    const control = config(root);
    await createManagedSyncControl({ config: control, pid: 123, token: "stale" });
    await assert.rejects(
      stopManagedSyncControl({
        config: control,
        probeHealth: async () => true,
        processIsAlive: () => true,
        requestStatus: async () => ({
          status: "ok",
          pid: 456,
          activeRequestCount: 0,
          safeToStop: true,
          draining: false,
        }),
        requestStop: async () => {
          stops += 1;
          return true;
        },
      }),
      /not owned/,
    );
    assert.equal(stops, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsafe Sync ownership status refuses stop before sending a request", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-sync-control-busy-"));
  let stops = 0;
  try {
    const control = config(root);
    await createManagedSyncControl({ config: control, pid: 123, token: "secret" });
    await assert.rejects(
      stopManagedSyncControl({
        config: control,
        probeHealth: async () => true,
        processIsAlive: () => true,
        requestStatus: async () => ({
          status: "ok",
          pid: 123,
          activeRequestCount: 1,
          safeToStop: false,
          draining: false,
        }),
        requestStop: async () => {
          stops += 1;
          return true;
        },
      }),
      /active requests/,
    );
    assert.equal(stops, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authenticated Sync stop waits until health and ownership records disappear", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-sync-control-stop-"));
  const calls: string[] = [];
  let healthy = true;
  try {
    const control = config(root);
    await createManagedSyncControl({ config: control, pid: 123, token: "secret" });
    await stopManagedSyncControl({
      config: control,
      probeHealth: async () => healthy,
      processIsAlive: () => true,
      requestStatus: async () => ({
        status: "ok",
        pid: 123,
        activeRequestCount: 0,
        safeToStop: true,
        draining: false,
      }),
      requestStop: async (_baseUrl, token) => {
        calls.push(`stop:${token}`);
        healthy = false;
        await removeManagedSyncControl(control, 123);
        return true;
      },
      delay: async () => undefined,
    });
    assert.deepEqual(calls, ["stop:secret"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed Sync exit waits for both health and ownership records to disappear", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-sync-control-exit-"));
  let healthy = true;
  let delays = 0;
  try {
    const control = config(root);
    await createManagedSyncControl({ config: control, pid: 123, token: "secret" });
    await waitForManagedSyncExit({
      config: control,
      probeHealth: async () => healthy,
      delay: async () => {
        delays += 1;
        if (delays === 1) {
          healthy = false;
        } else {
          await removeManagedSyncControl(control, 123);
        }
      },
    });
    assert.equal(delays, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup removes only records still owned by the exiting Sync PID", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-sync-control-cleanup-"));
  try {
    const control = config(root);
    await createManagedSyncControl({ config: control, pid: 123, token: "old" });
    await createManagedSyncControl({ config: control, pid: 456, token: "new" });
    await removeManagedSyncControl(control, 123);
    assert.deepEqual(
      await inspectManagedSyncControl({
        config: control,
        probeHealth: async () => true,
        processIsAlive: () => true,
        requestStatus: async () => ({
          status: "ok",
          pid: 456,
          activeRequestCount: 0,
          safeToStop: true,
          draining: false,
        }),
      }),
      {
        running: true,
        managed: true,
        pid: 456,
        activeRequestCount: 0,
        safeToStop: true,
        draining: false,
      },
    );
    await removeManagedSyncControl(control, 456);
    assert.deepEqual(
      await inspectManagedSyncControl({
        config: control,
        probeHealth: async () => false,
        processIsAlive: () => false,
        requestStatus: async () => undefined,
      }),
      { running: false, managed: false },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
