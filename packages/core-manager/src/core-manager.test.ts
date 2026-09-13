import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { CoreHealth } from "@cinba/core-client";
import { createLocalCoreConfig } from "./config.ts";
import { ensureLocalCore } from "./core-manager.ts";

const HEALTH: CoreHealth = { status: "ok", revision: "unknown", safeToRestart: true };

function fakeChild(pid: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperties(child, {
    pid: { value: pid },
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
  });
  return child;
}

test("reuses a Core that is already healthy", async () => {
  let spawns = 0;
  let locks = 0;
  const status = await ensureLocalCore({
    probe: async () => HEALTH,
    spawnCore: () => {
      spawns += 1;
      return fakeChild(10);
    },
    acquireLock: async () => {
      locks += 1;
      return () => {};
    },
  });

  assert.equal(status.running, true);
  assert.equal(status.managed, false);
  assert.equal(spawns, 0);
  assert.equal(locks, 0);
});

test("starts one managed Core and records its runtime", async () => {
  const home = mkdtempSync(join(tmpdir(), "cinba-manager-"));
  const config = createLocalCoreConfig({ homeDirectory: home });
  let probes = 0;
  let releases = 0;
  try {
    const status = await ensureLocalCore({
      config,
      probe: async () => {
        probes += 1;
        return probes >= 3 ? HEALTH : undefined;
      },
      spawnCore: () => fakeChild(4242),
      acquireLock: async () => () => {
        releases += 1;
      },
      delay: async () => {},
    });

    assert.deepEqual(status, {
      running: true,
      managed: true,
      pid: 4242,
      health: HEALTH,
    });
    assert.equal(JSON.parse(readFileSync(config.runtimePath, "utf8")).pid, 4242);
    assert.equal(releases, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rechecks health after taking the lock", async () => {
  let probes = 0;
  let spawns = 0;
  const status = await ensureLocalCore({
    probe: async () => {
      probes += 1;
      return probes === 1 ? undefined : HEALTH;
    },
    spawnCore: () => {
      spawns += 1;
      return fakeChild(10);
    },
    acquireLock: async () => () => {},
  });

  assert.equal(status.running, true);
  assert.equal(spawns, 0);
});

test("concurrent callers produce only one Core process", async () => {
  const home = mkdtempSync(join(tmpdir(), "cinba-manager-"));
  const config = createLocalCoreConfig({ homeDirectory: home });
  let healthy = false;
  let spawns = 0;
  const options = {
    config,
    probe: async () => (healthy ? HEALTH : undefined),
    spawnCore: () => {
      spawns += 1;
      healthy = true;
      return fakeChild(4242);
    },
    pollIntervalMs: 1,
  };

  try {
    const [first, second] = await Promise.all([ensureLocalCore(options), ensureLocalCore(options)]);

    assert.equal(first.running, true);
    assert.equal(second.running, true);
    assert.equal(spawns, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
