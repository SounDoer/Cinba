import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { CoreHealth } from "@cinba/core-client";
import { createLocalCoreConfig } from "./config.ts";
import {
  createCoreProcessEnvironment,
  ensureLocalCore,
  normalizeLocalCoreLifetime,
  resolveLocalCoreRevision,
  stopLocalCore,
} from "./core-manager.ts";

const REVISION = "abcdef1234567890abcdef1234567890abcdef12";
const OLD_REVISION = "1234567890abcdef1234567890abcdef12345678";
const HEALTH: CoreHealth = { status: "ok", revision: REVISION, safeToRestart: true };

function fakeChild(pid: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperties(child, {
    pid: { value: pid },
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
  });
  return child;
}

test("a local Core spawned by Electron runs as the current on-demand revision", () => {
  const home = join(tmpdir(), "cinba-manager-home");
  const config = createLocalCoreConfig({ homeDirectory: home });
  const environment = createCoreProcessEnvironment(
    "secret",
    {
      PATH: "C:\\Windows",
      CINBA_DEFAULT_CORE_NAME: "Development",
      CINBA_STATE_DIR: "C:\\wrong-state",
      PI_CODING_AGENT_DIR: "C:\\wrong-pi",
    },
    config,
    REVISION,
  );

  assert.equal(environment.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(environment.CINBA_CORE_LIFETIME, "on-demand");
  assert.equal(environment.CINBA_REVISION, REVISION);
  assert.equal(environment.CINBA_LOCAL_CONTROL_TOKEN, "secret");
  assert.equal(environment.CINBA_PORT, "4517");
  assert.equal(environment.CINBA_STATE_DIR, config.stateDirectory);
  assert.equal(environment.PI_CODING_AGENT_DIR, config.piAgentDirectory);
  assert.equal(environment.CINBA_DEFAULT_CORE_NAME, undefined);
  assert.equal(environment.PATH, "C:\\Windows");
});

test("an isolated development Core keeps its explicit port and product name", () => {
  const config = {
    ...createLocalCoreConfig({ homeDirectory: join(tmpdir(), "cinba-manager-dev-home") }),
    baseUrl: "http://127.0.0.1:4518/",
    defaultCoreName: "workstation Dev",
  };
  const environment = createCoreProcessEnvironment("secret", {}, config, REVISION);
  assert.equal(environment.CINBA_PORT, "4518");
  assert.equal(environment.CINBA_DEFAULT_CORE_NAME, "workstation Dev");
});

test("reuses a Core that is already healthy", async () => {
  const home = mkdtempSync(join(tmpdir(), "cinba-manager-"));
  const config = createLocalCoreConfig({ homeDirectory: home });
  let spawns = 0;
  let locks = 0;
  try {
    const status = await ensureLocalCore({
      config,
      expectedRevision: REVISION,
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
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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
      state: "running",
      running: true,
      managed: true,
      pid: 4242,
      lifetime: "on-demand",
      safeToStop: true,
      health: HEALTH,
    });
    assert.equal(JSON.parse(readFileSync(config.runtimePath, "utf8")).pid, 4242);
    assert.equal(JSON.parse(readFileSync(config.controlPath, "utf8")).pid, 4242);
    assert.equal(releases, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an existing managed persistent Core is returned to on-demand", async () => {
  const home = mkdtempSync(join(tmpdir(), "cinba-manager-"));
  const config = createLocalCoreConfig({ homeDirectory: home });
  let running = false;
  let requestedLifetime: string | undefined;
  try {
    await ensureLocalCore({
      config,
      expectedRevision: REVISION,
      probe: async () => (running ? HEALTH : undefined),
      spawnCore: () => {
        running = true;
        return fakeChild(process.pid);
      },
      delay: async () => {},
    });

    const status = await ensureLocalCore({
      config,
      expectedRevision: REVISION,
      probe: async () => HEALTH,
      requestStatus: async () => ({
        status: "ok",
        lifetime: "persistent",
        pid: process.pid,
        clientCount: 1,
        safeToStop: true,
        draining: false,
      }),
      requestLifetime: async (_url, _token, lifetime) => {
        requestedLifetime = lifetime;
        return true;
      },
    });

    assert.equal(status.running, true);
    assert.equal(status.managed, true);
    assert.equal(status.lifetime, "on-demand");
    assert.equal(requestedLifetime, "on-demand");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the local revision is the normalized checkout commit", () => {
  assert.equal(
    resolveLocalCoreRevision("C:\\cinba", (root) => {
      assert.equal(root, "C:\\cinba");
      return `${REVISION.toUpperCase()}\n`;
    }),
    REVISION,
  );
});

test("normalizing lifetime never starts a stopped Core", async () => {
  const home = mkdtempSync(join(tmpdir(), "cinba-manager-"));
  const config = createLocalCoreConfig({ homeDirectory: home });
  try {
    assert.deepEqual(await normalizeLocalCoreLifetime({ config, probe: async () => undefined }), {
      state: "stopped",
      running: false,
      managed: false,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a safe managed Core from an old revision is restarted", async () => {
  const home = mkdtempSync(join(tmpdir(), "cinba-manager-"));
  const config = createLocalCoreConfig({ homeDirectory: home });
  let running = false;
  let revision = OLD_REVISION;
  let stopRequests = 0;
  let spawns = 0;
  try {
    await ensureLocalCore({
      config,
      expectedRevision: OLD_REVISION,
      probe: async () => (running ? { status: "ok", revision, safeToRestart: true } : undefined),
      spawnCore: () => {
        running = true;
        return fakeChild(process.pid);
      },
      delay: async () => {},
    });

    const status = await ensureLocalCore({
      config,
      expectedRevision: REVISION,
      probe: async () => (running ? { status: "ok", revision, safeToRestart: true } : undefined),
      requestStatus: async () => ({
        status: "ok",
        lifetime: "on-demand",
        pid: process.pid,
        clientCount: 1,
        safeToStop: true,
        draining: false,
      }),
      requestStop: async () => {
        stopRequests += 1;
        running = false;
        return true;
      },
      spawnCore: () => {
        spawns += 1;
        revision = REVISION;
        running = true;
        return fakeChild(process.pid);
      },
      delay: async () => {},
    });

    assert.equal(status.health?.revision, REVISION);
    assert.equal(stopRequests, 1);
    assert.equal(spawns, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a busy managed Core from an old revision is not stopped", async () => {
  const home = mkdtempSync(join(tmpdir(), "cinba-manager-"));
  const config = createLocalCoreConfig({ homeDirectory: home });
  let running = false;
  let stopRequests = 0;
  let requestedLifetime: string | undefined;
  try {
    await ensureLocalCore({
      config,
      expectedRevision: OLD_REVISION,
      probe: async () =>
        running ? { status: "ok", revision: OLD_REVISION, safeToRestart: false } : undefined,
      spawnCore: () => {
        running = true;
        return fakeChild(process.pid);
      },
      delay: async () => {},
    });

    await assert.rejects(
      ensureLocalCore({
        config,
        expectedRevision: REVISION,
        probe: async () => ({ status: "ok", revision: OLD_REVISION, safeToRestart: false }),
        requestStatus: async () => ({
          status: "ok",
          lifetime: "persistent",
          pid: process.pid,
          clientCount: 0,
          safeToStop: false,
          draining: false,
        }),
        requestLifetime: async (_url, _token, lifetime) => {
          requestedLifetime = lifetime;
          return true;
        },
        requestStop: async () => {
          stopRequests += 1;
          return true;
        },
      }),
      /busy.*old revision/i,
    );
    assert.equal(stopRequests, 0);
    assert.equal(requestedLifetime, "on-demand");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an external Core from another revision is never stopped or replaced", async () => {
  const home = mkdtempSync(join(tmpdir(), "cinba-manager-"));
  const config = createLocalCoreConfig({ homeDirectory: home });
  let stops = 0;
  let spawns = 0;
  try {
    await assert.rejects(
      ensureLocalCore({
        config,
        expectedRevision: REVISION,
        probe: async () => ({ status: "ok", revision: OLD_REVISION, safeToRestart: true }),
        requestStop: async () => {
          stops += 1;
          return true;
        },
        spawnCore: () => {
          spawns += 1;
          return fakeChild(42);
        },
      }),
      /different Cinba Core revision/i,
    );
    assert.deepEqual({ stops, spawns }, { stops: 0, spawns: 0 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a draining managed Core finishes before one replacement is started", async () => {
  const home = mkdtempSync(join(tmpdir(), "cinba-manager-"));
  const config = createLocalCoreConfig({ homeDirectory: home });
  let running = false;
  let draining = false;
  let spawns = 0;
  try {
    await ensureLocalCore({
      config,
      expectedRevision: REVISION,
      probe: async () => (running ? HEALTH : undefined),
      spawnCore: () => {
        running = true;
        return fakeChild(process.pid);
      },
      delay: async () => {},
    });
    draining = true;

    const status = await ensureLocalCore({
      config,
      expectedRevision: REVISION,
      probe: async () => (running ? HEALTH : undefined),
      requestStatus: async () => ({
        status: "ok",
        lifetime: "on-demand",
        pid: process.pid,
        clientCount: 0,
        safeToStop: true,
        draining,
      }),
      requestStop: async () => {
        running = false;
        return true;
      },
      spawnCore: () => {
        spawns += 1;
        draining = false;
        running = true;
        return fakeChild(process.pid);
      },
      delay: async () => {},
    });

    assert.equal(status.state, "running");
    assert.equal(spawns, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rechecks health after taking the lock", async () => {
  const home = mkdtempSync(join(tmpdir(), "cinba-manager-"));
  const config = createLocalCoreConfig({ homeDirectory: home });
  let probes = 0;
  let spawns = 0;
  try {
    const status = await ensureLocalCore({
      config,
      expectedRevision: REVISION,
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
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("reuses an on-demand Core discovered after taking the start lock", async () => {
  const home = mkdtempSync(join(tmpdir(), "cinba-manager-"));
  const config = createLocalCoreConfig({ homeDirectory: home });
  try {
    let running = false;
    await ensureLocalCore({
      config,
      expectedRevision: REVISION,
      probe: async () => (running ? HEALTH : undefined),
      spawnCore: () => {
        running = true;
        return fakeChild(process.pid);
      },
      delay: async () => {},
    });

    let probes = 0;
    let lifetimeRequests = 0;
    const status = await ensureLocalCore({
      config,
      expectedRevision: REVISION,
      probe: async () => {
        probes += 1;
        return probes === 1 ? undefined : HEALTH;
      },
      requestStatus: async () => ({
        status: "ok",
        lifetime: "on-demand",
        pid: process.pid,
        clientCount: 0,
        safeToStop: true,
        draining: false,
      }),
      requestLifetime: async () => {
        lifetimeRequests += 1;
        return true;
      },
      acquireLock: async () => () => {},
    });

    assert.equal(lifetimeRequests, 0);
    assert.equal(status.lifetime, "on-demand");
    assert.equal(status.pid, process.pid);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("concurrent callers produce only one Core process", async () => {
  const home = mkdtempSync(join(tmpdir(), "cinba-manager-"));
  const config = createLocalCoreConfig({ homeDirectory: home });
  let healthy = false;
  let spawns = 0;
  const options = {
    config,
    expectedRevision: REVISION,
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

test("a managed Core is asked to stop gracefully", async () => {
  const home = mkdtempSync(join(tmpdir(), "cinba-manager-"));
  const config = createLocalCoreConfig({ homeDirectory: home });
  let running = false;
  let stopRequests = 0;
  try {
    await ensureLocalCore({
      config,
      expectedRevision: REVISION,
      probe: async () => (running ? HEALTH : undefined),
      spawnCore: () => {
        running = true;
        return fakeChild(process.pid);
      },
      delay: async () => {},
    });

    const status = await stopLocalCore({
      config,
      probe: async () => (running ? HEALTH : undefined),
      requestStatus: async () => ({
        status: "ok",
        lifetime: "on-demand",
        pid: process.pid,
        clientCount: 0,
        safeToStop: true,
        draining: false,
      }),
      requestStop: async () => {
        stopRequests += 1;
        running = false;
        return true;
      },
      delay: async () => {},
    });

    assert.deepEqual(status, { state: "stopped", running: false, managed: false });
    assert.equal(stopRequests, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an external Core cannot be stopped through stale or missing local records", async () => {
  const home = mkdtempSync(join(tmpdir(), "cinba-manager-"));
  const config = createLocalCoreConfig({ homeDirectory: home });
  try {
    await assert.rejects(stopLocalCore({ config, probe: async () => HEALTH }), {
      message: "The running Cinba Core is external and cannot be stopped by this manager",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
