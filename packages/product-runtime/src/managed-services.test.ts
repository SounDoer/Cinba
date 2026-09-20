import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { LocalCoreControlStatus } from "@cinba/core-client";
import type { LocalCoreConfig } from "@cinba/core-manager";
import {
  type PlatformServiceAdapter,
  createLinuxSystemdUserAdapter,
  readServiceState,
  resolveProductPaths,
} from "@cinba/installer";
import { temporaryDirectory } from "@cinba/test-support";
import { createCoreServiceControlConfig } from "./core-service-control.ts";
import {
  type ProductManagedServiceOptions,
  formatProductComponentMode,
  inspectProductComponentMode,
  setProductComponentMode,
} from "./managed-services.ts";
import { createManagedSyncControl } from "./sync-control.ts";

function fakeAdapter(): PlatformServiceAdapter & { registered: boolean; running: boolean } {
  return {
    registered: false,
    running: false,
    async inspect() {
      return { registered: this.registered, running: this.running };
    },
    async install() {
      this.registered = true;
    },
    async remove() {
      this.registered = false;
    },
    async start() {
      this.running = true;
    },
    async stop() {
      this.running = false;
    },
  };
}

function nativeOptions(root: string): ProductManagedServiceOptions {
  if (
    process.platform !== "win32" &&
    process.platform !== "darwin" &&
    process.platform !== "linux"
  ) {
    throw new Error(`unsupported test platform: ${process.platform}`);
  }
  return {
    platform: process.platform,
    homeDirectory: root,
    environment: process.platform === "win32" ? { LOCALAPPDATA: join(root, "Local") } : {},
  };
}

test("the product management facade controls Core through the shared service manager", async (t) => {
  const root = temporaryDirectory("cinba-product-service-", t);
  const adapter = fakeAdapter();
  const options = {
    ...nativeOptions(root),
    adapter,
    verifyHealth: async () => undefined,
  };
  const initial = await inspectProductComponentMode("core", options);
  assert.equal(initial.state, "on-demand");
  const background = await setProductComponentMode("core", "background", options);
  assert.equal(background.state, "background");
  assert.match(formatProductComponentMode(background), /Service: running/);
  const onDemand = await setProductComponentMode("core", "on-demand", options);
  assert.equal(onDemand.state, "on-demand");
  assert.equal(adapter.registered, false);
});

test("Sync remains not created until its authority directory exists", async (t) => {
  const root = temporaryDirectory("cinba-product-sync-", t);
  const status = await inspectProductComponentMode("sync", {
    ...nativeOptions(root),
    adapter: fakeAdapter(),
  });
  assert.equal(status.state, "not-created");
  assert.equal(formatProductComponentMode(status), "Cinba Sync: not created");
});

function stateDirectory(options: ProductManagedServiceOptions): string {
  return resolveProductPaths({
    platform: options.platform!,
    homeDirectory: options.homeDirectory!,
    environment: options.environment!,
  }).stateDirectory;
}

async function onDemandCore(root: string): Promise<LocalCoreConfig> {
  const state = join(root, "core-state");
  const config: LocalCoreConfig = {
    baseUrl: "http://127.0.0.1:4517/",
    repositoryRoot: join(root, "payload"),
    serverEntry: join(root, "payload", "lib", "core.mjs"),
    stateDirectory: join(root, "data", "Core"),
    piAgentDirectory: join(root, "data", "Pi"),
    startLockPath: join(state, "core-start.lock"),
    runtimePath: join(state, "core-runtime.json"),
    controlPath: join(state, "core-control.json"),
    logPath: join(root, "logs", "core.log"),
  };
  await mkdir(state, { recursive: true });
  const record = { pid: process.pid, repositoryRoot: config.repositoryRoot };
  await writeFile(
    config.runtimePath,
    JSON.stringify({ ...record, startedAt: new Date().toISOString() }),
  );
  await writeFile(config.controlPath, JSON.stringify({ ...record, token: "on-demand-token" }));
  return config;
}

/** One local port shared by an on-demand Core and the Background service, as on a real host. */
function sharedCorePort(onDemand: { safeToStop: boolean }) {
  const port = {
    onDemandRunning: true,
    serviceRunning: false,
    stopRequests: 0,
    async probe() {
      return port.onDemandRunning || port.serviceRunning
        ? { status: "ok" as const, revision: "a".repeat(40), safeToRestart: onDemand.safeToStop }
        : undefined;
    },
    async requestStatus(
      _baseUrl: string,
      token: string,
    ): Promise<LocalCoreControlStatus | undefined> {
      const base = { status: "ok" as const, clientCount: 1, draining: false };
      if (token === "on-demand-token" && port.onDemandRunning) {
        return { ...base, lifetime: "on-demand", pid: process.pid, ...onDemand };
      }
      if (token === "service-token" && port.serviceRunning) {
        return { ...base, lifetime: "persistent", pid: process.pid, safeToStop: true };
      }
      return undefined;
    },
    async requestStop(_baseUrl: string, token: string) {
      assert.equal(token, "on-demand-token");
      port.stopRequests += 1;
      port.onDemandRunning = false;
      return true;
    },
  };
  return port;
}

test("Background takes over from an idle on-demand Core before starting the service", async (t) => {
  const root = temporaryDirectory("cinba-product-handoff-", t);
  const base = nativeOptions(root);
  const config = await onDemandCore(root);
  const port = sharedCorePort({ safeToStop: true });
  const adapter = fakeAdapter();
  adapter.start = async () => {
    assert.equal(port.onDemandRunning, false, "the on-demand Core must release the port first");
    await access(config.startLockPath);
    await createManagedSyncControl({
      config: createCoreServiceControlConfig(stateDirectory(base)),
      pid: process.pid,
      token: "service-token",
    });
    port.serviceRunning = true;
    adapter.running = true;
  };
  const status = await setProductComponentMode("core", "background", {
    ...base,
    adapter,
    localCore: {
      config,
      probe: port.probe,
      requestStatus: port.requestStatus,
      requestStop: port.requestStop,
    },
  });
  assert.equal(status.state, "background");
  assert.equal(status.state === "background" && status.healthy, true);
  assert.equal(port.stopRequests, 1);
  await assert.rejects(access(config.startLockPath), { code: "ENOENT" });
});

test("Background refuses to take over while the on-demand Core has active work", async (t) => {
  const root = temporaryDirectory("cinba-product-busy-", t);
  const base = nativeOptions(root);
  const config = await onDemandCore(root);
  const port = sharedCorePort({ safeToStop: false });
  const adapter = fakeAdapter();
  await assert.rejects(
    setProductComponentMode("core", "background", {
      ...base,
      adapter,
      localCore: {
        config,
        probe: port.probe,
        requestStatus: port.requestStatus,
        requestStop: port.requestStop,
      },
    }),
    /on-demand Cinba Core has active work/,
  );
  assert.equal(port.stopRequests, 0);
  assert.equal(port.onDemandRunning, true);
  assert.equal(adapter.registered, false);
  await assert.rejects(access(config.startLockPath), { code: "ENOENT" });
});

test("a Background service that exits is not verified by another Core on its port", async (t) => {
  const root = temporaryDirectory("cinba-product-impostor-", t);
  const base = nativeOptions(root);
  const config = await onDemandCore(root);
  const port = sharedCorePort({ safeToStop: true });
  const adapter = fakeAdapter();
  adapter.start = async () => {
    // The service records its identity, loses the port race, and exits; another Core answers.
    await createManagedSyncControl({
      config: createCoreServiceControlConfig(stateDirectory(base)),
      pid: process.pid,
      token: "service-token",
    });
    port.onDemandRunning = true;
    adapter.running = true;
  };
  await assert.rejects(
    setProductComponentMode("core", "background", {
      ...base,
      adapter,
      localCore: {
        config,
        probe: port.probe,
        requestStatus: port.requestStatus,
        requestStop: port.requestStop,
      },
    }),
    /could not set Cinba Core to background/,
  );
  const state = await readServiceState(stateDirectory(base));
  assert.equal(state?.core.mode, "on-demand");
  assert.equal(state?.core.failure, "health-failed");
  assert.equal(adapter.registered, false);
});

test("a host without systemd keeps Core on-demand and can still leave Background", async (t) => {
  const root = temporaryDirectory("cinba-product-no-systemd-", t);
  const base = nativeOptions(root);
  const config = await onDemandCore(root);
  const port = sharedCorePort({ safeToStop: true });
  const adapter = createLinuxSystemdUserAdapter({
    userName: "cinba",
    userUnitDirectory: join(root, "systemd", "user"),
    runCommand: async (command) => {
      throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
    },
  });
  const options = { ...base, adapter, verifyHealth: async () => undefined };
  const status = await inspectProductComponentMode("core", options);
  assert.equal(status.state, "on-demand");
  assert.match(
    formatProductComponentMode(status),
    /Background: unavailable \(this host does not run systemd/,
  );
  await assert.rejects(
    setProductComponentMode("core", "background", {
      ...options,
      localCore: {
        config,
        probe: port.probe,
        requestStatus: port.requestStatus,
        requestStop: port.requestStop,
      },
    }),
    /Background is unavailable because this host does not run systemd/,
  );
  assert.equal(port.stopRequests, 0, "a refused Background must not stop the on-demand Core");
  assert.equal((await inspectProductComponentMode("core", options)).state, "on-demand");
  // Uninstall's path: every mode change away from Background succeeds with nothing to remove.
  assert.equal((await setProductComponentMode("core", "on-demand", options)).state, "on-demand");
  const sync = await setProductComponentMode("sync", "disabled", {
    ...options,
    componentCreated: true,
  });
  assert.equal(sync.state, "disabled");
});
