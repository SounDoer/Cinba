import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import {
  type PlatformServiceAdapter,
  acquireInstallationLock,
  resolveProductPaths,
} from "@cinba/installer";
import { temporaryDirectory } from "@cinba/test-support";
import {
  configureProductSyncHost,
  createManagedSyncControl,
  createManagedSyncControlConfig,
  createSyncHostConfig,
  formatProductSyncHostStatus,
  inspectProductSyncHost,
  removeManagedSyncControl,
  setProductComponentMode,
  setProductSyncHostMode,
  syncHostConfigPath,
  writeSyncHostConfig,
} from "./index.ts";

test("human Host status names an installation that has not been created", () => {
  assert.equal(
    formatProductSyncHostStatus({ schemaVersion: 1, state: "not-created" }),
    "Cinba Sync Host: not created",
  );
});

test("human Host status explains why an installation needs repair", () => {
  assert.equal(
    formatProductSyncHostStatus({
      schemaVersion: 1,
      state: "repair-required",
      reason: "invalid-config",
    }),
    "Cinba Sync Host: repair required\n  Reason: invalid config",
  );
});

test("human Host status describes a created remote Host without inventing health", () => {
  assert.equal(
    formatProductSyncHostStatus({
      schemaVersion: 1,
      state: "created",
      publicOrigin: "https://sync.example.com",
      availability: "remote-https",
      mode: "disabled",
      running: false,
      healthy: null,
    }),
    [
      "Cinba Sync Host: created",
      "  Public origin: https://sync.example.com",
      "  Availability: Remote HTTPS",
      "  Mode: disabled",
      "  Service: stopped",
    ].join("\n"),
  );
});

test("human Host status reports local-only availability and known health", () => {
  assert.equal(
    formatProductSyncHostStatus({
      schemaVersion: 1,
      state: "created",
      publicOrigin: "http://127.0.0.1:4518",
      availability: "this-device-only",
      mode: "background",
      running: true,
      healthy: true,
    }),
    [
      "Cinba Sync Host: created",
      "  Public origin: http://127.0.0.1:4518",
      "  Availability: This device only",
      "  Mode: background",
      "  Service: running",
      "  Health: healthy",
    ].join("\n"),
  );
});

test("configuring an absent Host refuses without creating storage", async (t) => {
  const root = temporaryDirectory("cinba-sync-host-configure-absent-", t);
  const { options, paths } = nativeLayout(root);

  await assert.rejects(configureProductSyncHost("https://sync.example.com", options), {
    message: "Cinba Sync Host has not been created",
  });
  await assert.rejects(access(paths.configurationDirectory), { code: "ENOENT" });
  await assert.rejects(access(paths.syncDataDirectory), { code: "ENOENT" });
});

test("configuring a stopped Host atomically updates only its public origin", async (t) => {
  const root = temporaryDirectory("cinba-sync-host-configure-stopped-", t);
  const { options, paths } = nativeLayout(root);
  await mkdir(paths.syncDataDirectory, { recursive: true });
  await writeSyncHostConfig(syncHostConfigPath(paths), createSyncHostConfig());

  assert.deepEqual(
    await configureProductSyncHost("https://sync.example.com", {
      ...options,
      adapter: stoppedServiceAdapter(),
    }),
    {
      schemaVersion: 1,
      state: "created",
      publicOrigin: "https://sync.example.com",
      availability: "remote-https",
      mode: "disabled",
      running: false,
      healthy: null,
    },
  );
  assert.deepEqual(
    JSON.parse(await readFile(syncHostConfigPath(paths), "utf8")) as unknown,
    createSyncHostConfig("https://sync.example.com"),
  );
  await access(paths.syncDataDirectory);
});

test("configuring the current origin is a no-op for a running Host", async (t) => {
  const root = temporaryDirectory("cinba-sync-host-configure-noop-", t);
  const { options, paths } = nativeLayout(root);
  await mkdir(paths.syncDataDirectory, { recursive: true });
  await writeSyncHostConfig(
    syncHostConfigPath(paths),
    createSyncHostConfig("https://sync.example.com"),
  );
  let mutations = 0;
  const adapter: PlatformServiceAdapter = {
    inspect: async () => ({ registered: true, running: true }),
    install: async () => {
      mutations += 1;
    },
    remove: async () => {
      mutations += 1;
    },
    start: async () => {
      mutations += 1;
    },
    stop: async () => {
      mutations += 1;
    },
  };

  const status = await configureProductSyncHost("https://sync.example.com", {
    ...options,
    adapter,
    verifyHealth: async () => undefined,
  });

  assert.equal(status.state, "created");
  assert.equal(status.publicOrigin, "https://sync.example.com");
  assert.equal(status.running, true);
  assert.equal(status.healthy, true);
  assert.equal(mutations, 0);
});

test("configuring a Host refuses before writing while another product transaction holds the lock", async (t) => {
  const root = temporaryDirectory("cinba-sync-host-configure-locked-", t);
  const { options, paths } = nativeLayout(root);
  await mkdir(paths.syncDataDirectory, { recursive: true });
  await writeSyncHostConfig(syncHostConfigPath(paths), createSyncHostConfig());
  const unlock = await acquireInstallationLock({
    programDirectory: paths.programDirectory,
    releasesDirectory: paths.releasesDirectory,
    transactionDirectory: paths.transactionDirectory,
  });

  try {
    await assert.rejects(
      configureProductSyncHost("https://sync.example.com", {
        ...options,
        adapter: stoppedServiceAdapter(),
      }),
      /another Cinba installation transaction is active/,
    );
    assert.deepEqual(
      JSON.parse(await readFile(syncHostConfigPath(paths), "utf8")) as unknown,
      createSyncHostConfig(),
    );
  } finally {
    await unlock();
  }
});

test("configuring a running Background Host drains it before restarting with the new origin", async (t) => {
  const root = temporaryDirectory("cinba-sync-host-configure-running-", t);
  const { options, paths } = nativeLayout(root);
  await mkdir(paths.syncDataDirectory, { recursive: true });
  await writeSyncHostConfig(syncHostConfigPath(paths), createSyncHostConfig());
  const events: string[] = [];
  let registered = false;
  let running = false;
  const adapter: PlatformServiceAdapter = {
    inspect: async () => ({ registered, running }),
    install: async () => {
      events.push("install");
      registered = true;
    },
    remove: async () => {
      events.push("remove");
      registered = false;
    },
    start: async () => {
      events.push("start");
      running = true;
    },
    stop: async () => {
      events.push("stop");
      running = false;
    },
  };
  const verifyHealth = async () => {
    if (!running) {
      throw new Error("Sync is stopped");
    }
  };
  await setProductComponentMode("sync", "background", {
    ...options,
    adapter,
    componentCreated: true,
    verifyHealth,
  });
  events.length = 0;
  const control = createManagedSyncControlConfig(paths.stateDirectory);
  await createManagedSyncControl({ config: control, pid: process.pid, token: "manager-token" });

  const status = await configureProductSyncHost("https://sync.example.com", {
    ...options,
    adapter,
    verifyHealth,
    syncControl: {
      probeHealth: async () => running,
      processIsAlive: () => true,
      requestStatus: async () => ({
        status: "ok",
        pid: process.pid,
        activeRequestCount: 0,
        safeToStop: true,
        draining: false,
      }),
      requestStop: async () => {
        events.push("drain");
        running = false;
        await removeManagedSyncControl(control, process.pid);
        return "accepted";
      },
      delay: async () => undefined,
    },
  });

  assert.deepEqual(events, ["drain", "stop", "start"]);
  assert.equal(status.state, "created");
  assert.equal(status.publicOrigin, "https://sync.example.com");
  assert.equal(status.mode, "background");
  assert.equal(status.running, true);
});

test("a failed Background restart restores the old origin before recovering the service", async (t) => {
  const root = temporaryDirectory("cinba-sync-host-configure-rollback-", t);
  const { options, paths } = nativeLayout(root);
  const configPath = syncHostConfigPath(paths);
  await mkdir(paths.syncDataDirectory, { recursive: true });
  await writeSyncHostConfig(configPath, createSyncHostConfig());
  let registered = false;
  let running = false;
  let configuring = false;
  const restartOrigins: string[] = [];
  const adapter: PlatformServiceAdapter = {
    inspect: async () => ({ registered, running }),
    install: async () => {
      registered = true;
    },
    remove: async () => {
      registered = false;
    },
    start: async () => {
      const origin = (JSON.parse(await readFile(configPath, "utf8")) as { publicOrigin: string })
        .publicOrigin;
      if (configuring) {
        restartOrigins.push(origin);
        if (restartOrigins.length === 1) {
          throw new Error("new origin failed health startup");
        }
      }
      running = true;
    },
    stop: async () => {
      running = false;
    },
  };
  const verifyHealth = async () => {
    if (!running) {
      throw new Error("Sync is stopped");
    }
  };
  await setProductComponentMode("sync", "background", {
    ...options,
    adapter,
    componentCreated: true,
    verifyHealth,
  });
  const control = createManagedSyncControlConfig(paths.stateDirectory);
  await createManagedSyncControl({ config: control, pid: process.pid, token: "manager-token" });
  configuring = true;

  await assert.rejects(
    configureProductSyncHost("https://sync.example.com", {
      ...options,
      adapter,
      verifyHealth,
      syncControl: {
        probeHealth: async () => running,
        processIsAlive: () => true,
        requestStatus: async () => ({
          status: "ok",
          pid: process.pid,
          activeRequestCount: 0,
          safeToStop: true,
          draining: false,
        }),
        requestStop: async () => {
          running = false;
          await removeManagedSyncControl(control, process.pid);
          return "accepted";
        },
        delay: async () => undefined,
      },
    }),
    /new origin failed health startup/,
  );

  assert.deepEqual(restartOrigins, ["https://sync.example.com", "http://127.0.0.1:4518"]);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), createSyncHostConfig());
  assert.equal(running, true);
});

function nativeLayout(root: string) {
  if (
    process.platform !== "win32" &&
    process.platform !== "darwin" &&
    process.platform !== "linux"
  ) {
    throw new Error(`unsupported test platform: ${process.platform}`);
  }
  const environment = process.platform === "win32" ? { LOCALAPPDATA: root } : {};
  return {
    options: { platform: process.platform, homeDirectory: root, environment },
    paths: resolveProductPaths({
      platform: process.platform,
      homeDirectory: root,
      environment,
    }),
  };
}

function stoppedServiceAdapter(): PlatformServiceAdapter {
  return {
    inspect: async () => ({ registered: false, running: false }),
    install: async () => undefined,
    remove: async () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
  };
}

test("an installation without a Sync Host reports not created without initializing storage", async (t) => {
  const homeDirectory = temporaryDirectory("cinba-sync-host-manager-", t);
  const { options, paths } = nativeLayout(homeDirectory);
  const status = await inspectProductSyncHost(options);
  assert.deepEqual(status, { schemaVersion: 1, state: "not-created" });

  await assert.rejects(access(paths.configurationDirectory), { code: "ENOENT" });
  await assert.rejects(access(paths.syncDataDirectory), { code: "ENOENT" });
});

test("an authority without committed Host config requires explicit repair", async (t) => {
  const root = temporaryDirectory("cinba-sync-host-orphan-", t);
  const { options, paths } = nativeLayout(root);
  await mkdir(paths.syncDataDirectory, { recursive: true });

  assert.deepEqual(await inspectProductSyncHost(options), {
    schemaVersion: 1,
    state: "repair-required",
    reason: "orphaned-authority",
  });
});

test("an orphaned authority cannot be promoted to a Background Host", async (t) => {
  const root = temporaryDirectory("cinba-sync-host-orphan-mode-", t);
  const { options, paths } = nativeLayout(root);
  await mkdir(paths.syncDataDirectory, { recursive: true });
  let mutations = 0;
  const adapter: PlatformServiceAdapter = {
    inspect: async () => ({ registered: false, running: false }),
    install: async () => {
      mutations += 1;
    },
    remove: async () => {
      mutations += 1;
    },
    start: async () => {
      mutations += 1;
    },
    stop: async () => {
      mutations += 1;
    },
  };

  await assert.rejects(setProductSyncHostMode("background", { ...options, adapter }), {
    message: "Cinba Sync Host requires repair: orphaned-authority",
  });
  assert.equal(mutations, 0);
});

test("a committed Host changes mode through the shared platform service adapter", async (t) => {
  const root = temporaryDirectory("cinba-sync-host-mode-", t);
  const { options, paths } = nativeLayout(root);
  await mkdir(paths.syncDataDirectory, { recursive: true });
  await writeSyncHostConfig(syncHostConfigPath(paths), createSyncHostConfig());
  let registered = false;
  let running = false;
  const adapter: PlatformServiceAdapter = {
    inspect: async () => ({ registered, running }),
    install: async () => {
      registered = true;
    },
    remove: async () => {
      registered = false;
    },
    start: async () => {
      running = true;
    },
    stop: async () => {
      running = false;
    },
  };

  assert.deepEqual(
    await setProductSyncHostMode("background", {
      ...options,
      adapter,
      verifyHealth: async () => undefined,
    }),
    {
      schemaVersion: 1,
      state: "created",
      publicOrigin: "http://127.0.0.1:4518",
      availability: "this-device-only",
      mode: "background",
      running: true,
      healthy: true,
    },
  );
});

test("committed Host config without its authority requires explicit repair", async (t) => {
  const root = temporaryDirectory("cinba-sync-host-missing-authority-", t);
  const { options, paths } = nativeLayout(root);
  await writeSyncHostConfig(syncHostConfigPath(paths), createSyncHostConfig());

  assert.deepEqual(await inspectProductSyncHost(options), {
    schemaVersion: 1,
    state: "repair-required",
    reason: "missing-authority",
  });
});

test("invalid Host config is preserved and reported as requiring repair", async (t) => {
  const root = temporaryDirectory("cinba-sync-host-invalid-config-", t);
  const { options, paths } = nativeLayout(root);
  const configPath = syncHostConfigPath(paths);
  await mkdir(paths.configurationDirectory, { recursive: true });
  await writeFile(configPath, '{"schemaVersion":2,"publicOrigin":"https://sync.example.com"}\n');

  assert.deepEqual(await inspectProductSyncHost(options), {
    schemaVersion: 1,
    state: "repair-required",
    reason: "invalid-config",
  });
  assert.equal(
    await readFile(configPath, "utf8"),
    '{"schemaVersion":2,"publicOrigin":"https://sync.example.com"}\n',
  );
});

test("a committed Host reports its origin, availability, and lifecycle", async (t) => {
  const root = temporaryDirectory("cinba-sync-host-created-", t);
  const { options, paths } = nativeLayout(root);
  await mkdir(paths.syncDataDirectory, { recursive: true });
  await writeSyncHostConfig(
    syncHostConfigPath(paths),
    createSyncHostConfig("https://sync.example.com"),
  );

  assert.deepEqual(await inspectProductSyncHost({ ...options, adapter: stoppedServiceAdapter() }), {
    schemaVersion: 1,
    state: "created",
    publicOrigin: "https://sync.example.com",
    availability: "remote-https",
    mode: "disabled",
    running: false,
    healthy: null,
  });
});
