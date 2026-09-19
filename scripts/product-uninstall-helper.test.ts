import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  type PlatformServiceAdapter,
  acquireInstallationLock,
  resolveProductPaths,
} from "@cinba/installer";
import {
  type ProductManagedServiceOptions,
  setProductComponentMode,
} from "../packages/product-runtime/src/managed-services.ts";
import {
  deferWindowsProgramRemoval,
  launchUninstallHelper,
  reportPreviousUninstallFailure,
  runUninstallHelper,
} from "./product-uninstall.ts";

const exitedProcessId = 2_147_483_647;

function testProduct(root: string) {
  if (
    process.platform !== "win32" &&
    process.platform !== "darwin" &&
    process.platform !== "linux"
  ) {
    throw new Error(`unsupported test platform: ${process.platform}`);
  }
  const environment = process.platform === "win32" ? { LOCALAPPDATA: join(root, "Local") } : {};
  const adapter: PlatformServiceAdapter & { registered: boolean; running: boolean } = {
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
  const serviceOptions: ProductManagedServiceOptions = {
    platform: process.platform,
    homeDirectory: root,
    environment,
    adapter,
    verifyHealth: async () => undefined,
  };
  return {
    paths: resolveProductPaths({ platform: process.platform, homeDirectory: root, environment }),
    adapter,
    serviceOptions,
  };
}

test("a surface-initiated helper changes service modes under the lock it was launched with", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-uninstall-helper-lock-"));
  const { paths, adapter, serviceOptions } = testProduct(root);
  let helperDirectory: string | undefined;
  try {
    await setProductComponentMode("core", "background", serviceOptions);
    assert.equal(adapter.registered, true);

    // This test process stands in for the detached helper, so the lock is taken for its PID.
    const spawnHelper = ((command: string) => {
      helperDirectory = dirname(command);
      const child = Object.assign(new EventEmitter(), {
        pid: process.pid,
        unref: () => undefined,
        kill: () => true,
      });
      setImmediate(() => child.emit("spawn"));
      return child;
    }) as unknown as typeof spawn;
    await launchUninstallHelper(
      { purge: false, blockingProcessId: exitedProcessId },
      { paths, spawnHelper },
    );

    const installerWaits = async () =>
      await assert.rejects(acquireInstallationLock(paths), /installation transaction is active/);
    await installerWaits();
    const removals: boolean[] = [];
    await runUninstallHelper(
      { parentProcessId: exitedProcessId, purge: false, blockingProcessId: exitedProcessId },
      {
        paths,
        stopProduct: async (options) => {
          await setProductComponentMode("core", "on-demand", {
            ...serviceOptions,
            ...(options?.installationLockHeld ? { installationLockHeld: true } : {}),
          });
        },
        removeProduct: async (_platform, purge) => {
          await installerWaits();
          removals.push(purge);
        },
      },
    );

    assert.equal(adapter.registered, false);
    assert.deepEqual(removals, [false]);
    await assert.rejects(access(join(paths.logDirectory, "uninstall-helper.log")), {
      code: "ENOENT",
    });
  } finally {
    if (helperDirectory) {
      await rm(helperDirectory, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed helper leaves a log that the next launch reports once", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-uninstall-helper-failure-"));
  const { paths } = testProduct(root);
  try {
    // Without the lock from its launcher the helper must not touch services or files.
    await assert.rejects(
      runUninstallHelper(
        { parentProcessId: exitedProcessId, purge: false, blockingProcessId: exitedProcessId },
        {
          paths,
          stopProduct: async () => assert.fail("stopped without the installation lock"),
          removeProduct: async () => assert.fail("removed without the installation lock"),
        },
      ),
      /does not hold the installation lock/,
    );
    assert.match(
      await readFile(join(paths.logDirectory, "uninstall-helper.log"), "utf8"),
      /uninstall failed: Error: the Cinba uninstall helper does not hold the installation lock/,
    );
    // Each step's time since the helper started shows where a slow uninstall waited.
    assert.match(
      await readFile(join(paths.logDirectory, "uninstall-helper.log"), "utf8"),
      /phases: launcher exited \d+ms, surface exited \d+ms, failed \d+ms/,
    );

    const warnings: string[] = [];
    await reportPreviousUninstallFailure(paths, (message) => warnings.push(message));
    await reportPreviousUninstallFailure(paths, (message) => warnings.push(message));
    assert.deepEqual(warnings, [
      `[cinba] The last Cinba uninstall did not finish. Details: ${join(paths.logDirectory, "uninstall-helper.reported.log")}`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a locked Windows program directory is moved aside and removed in the background", async () => {
  const program = join("C:", "Users", "Ada", "AppData", "Local", "Programs", "Cinba");
  const logs = join("C:", "Users", "Ada", "AppData", "Local", "Cinba", "Logs");
  const moves: string[][] = [];
  const scheduled: unknown[] = [];
  await deferWindowsProgramRemoval(program, logs, {
    move: async (from, to) => {
      moves.push([from, to]);
    },
    schedule: (directory, options) => scheduled.push([directory, options]),
  });
  const aside = `${program}.uninstall-${String(process.pid)}`;
  assert.deepEqual(moves, [[program, aside]]);
  assert.deepEqual(scheduled, [[aside, { failureLog: join(logs, "uninstall-helper.log") }]]);

  // A lock that also blocks the rename still gets the directory removed where it is.
  const scheduledInPlace: unknown[] = [];
  await deferWindowsProgramRemoval(program, logs, {
    move: async () => {
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    },
    schedule: (directory, options) => scheduledInPlace.push([directory, options]),
  });
  assert.deepEqual(scheduledInPlace, [
    [program, { failureLog: join(logs, "uninstall-helper.log") }],
  ]);
});

test("starting a helper clears helper copies abandoned by a killed launcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-uninstall-abandoned-"));
  const temporaryDirectory = join(root, "Temp");
  const { paths } = testProduct(root);
  const abandoned = join(temporaryDirectory, "cinba-uninstall-abandoned");
  const recent = join(temporaryDirectory, "cinba-uninstall-recent");
  const unrelated = join(temporaryDirectory, "unrelated-old");
  try {
    for (const directory of [abandoned, recent, unrelated]) {
      await mkdir(directory, { recursive: true });
    }
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    await utimes(abandoned, hourAgo, hourAgo);
    await utimes(unrelated, hourAgo, hourAgo);

    let helperOptions: { cwd?: unknown } | undefined;
    const spawnHelper = ((_command: string, _arguments: string[], options: { cwd?: unknown }) => {
      helperOptions = options;
      const child = Object.assign(new EventEmitter(), {
        pid: process.pid,
        unref: () => undefined,
        kill: () => true,
      });
      setImmediate(() => child.emit("spawn"));
      return child;
    }) as unknown as typeof spawn;
    await launchUninstallHelper(
      { purge: false, blockingProcessId: exitedProcessId },
      { paths, spawnHelper, temporaryDirectory },
    );
    // Started from Desktop, the launcher works in Desktop's directory; the helper must not.
    assert.equal(helperOptions?.cwd, temporaryDirectory);

    const remaining = await readdir(temporaryDirectory);
    assert.equal(remaining.includes("cinba-uninstall-abandoned"), false);
    assert.equal(remaining.includes("cinba-uninstall-recent"), true);
    assert.equal(remaining.includes("unrelated-old"), true);
    // The new helper copy sits beside them.
    assert.equal(remaining.filter((name) => name.startsWith("cinba-uninstall-")).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
