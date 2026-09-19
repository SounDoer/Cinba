import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
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
