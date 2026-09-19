import { type ChildProcess, spawn } from "node:child_process";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import { createInterface } from "node:readline/promises";
import { type LocalCoreConfig, inspectLocalCore, stopLocalCore } from "@cinba/core-manager";
import {
  type ProductPaths,
  acquireInstallationLock,
  createUninstallPlan,
  executeUninstallPlan,
  installationLockHeldBy,
  readCurrentRelease,
  releasePath,
  removePosixLauncherPathBlock,
  removeWindowsProductIntegration,
  removeWindowsUserPath,
  resolveProductPaths,
  stopWindowsDesktopApplication,
} from "@cinba/installer";
import {
  inspectProductComponentMode,
  setProductComponentMode,
} from "../packages/product-runtime/src/managed-services.ts";
import { scheduleWindowsHelperDirectoryRemoval } from "./windows-helper-cleanup.ts";

type SupportedPlatform = "win32" | "darwin" | "linux";

function supportedPlatform(): SupportedPlatform {
  if (
    process.platform !== "win32" &&
    process.platform !== "darwin" &&
    process.platform !== "linux"
  ) {
    throw new Error(`Cinba is not available on ${process.platform}`);
  }
  return process.platform;
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function uninstallCoreConfig(options: {
  platform: SupportedPlatform;
  payloadRoot: string;
  paths: ReturnType<typeof resolveProductPaths>;
}): LocalCoreConfig {
  const productJoin = options.platform === "win32" ? win32.join : posix.join;
  return {
    baseUrl: "http://127.0.0.1:4517/",
    repositoryRoot: options.payloadRoot,
    serverEntry: productJoin(options.payloadRoot, "lib", "core.mjs"),
    stateDirectory: productJoin(options.paths.dataDirectory, "Core"),
    piAgentDirectory: productJoin(options.paths.dataDirectory, "Pi"),
    startLockPath: productJoin(options.paths.stateDirectory, "core-start.lock"),
    runtimePath: productJoin(options.paths.stateDirectory, "core-runtime.json"),
    controlPath: productJoin(options.paths.stateDirectory, "core-control.json"),
    logPath: productJoin(options.paths.logDirectory, "core.log"),
  };
}

async function waitForParentExit(
  processId: number,
  description = "the Cinba launcher",
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (!processExists(processId)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${description} did not exit in time`);
}

export async function confirmPurge(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "non-interactive purge requires --delete-all-cinba-data in addition to --purge",
    );
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("This permanently deletes all Cinba data, credentials, and Sync authority.");
    const answer = await prompt.question('Type "DELETE ALL CINBA DATA" to continue: ');
    if (answer !== "DELETE ALL CINBA DATA") {
      throw new Error("Cinba purge cancelled");
    }
  } finally {
    prompt.close();
  }
}

export type StopProductForUninstallOptions = {
  stopDesktop?: boolean;
  /** The uninstall helper already owns the installation lock; service mode changes reuse it. */
  installationLockHeld?: boolean;
};

export async function stopProductForUninstall(
  options: StopProductForUninstallOptions = {},
): Promise<void> {
  const platform = supportedPlatform();
  const homeDirectory = homedir();
  const paths = resolveProductPaths({ platform, homeDirectory, environment: process.env });
  const current = await readCurrentRelease(paths);
  const payloadRoot = current ? releasePath(paths, current) : paths.programDirectory;
  const config = uninstallCoreConfig({
    platform,
    payloadRoot,
    paths,
  });
  const localCore = await inspectLocalCore(config);
  if (localCore.running && localCore.managed && localCore.safeToStop === false) {
    throw new Error("Cinba cannot be uninstalled while the local Core has active work");
  }
  // A running Desktop keeps its program files open, which would stall the uninstall helper.
  if (platform === "win32" && paths.desktopApplicationPath && options.stopDesktop !== false) {
    const stopped = await stopWindowsDesktopApplication({
      desktopApplicationPath: paths.desktopApplicationPath,
    });
    if (stopped > 0) {
      console.log("Cinba Desktop was closed.");
    }
  }

  const modeOptions = options.installationLockHeld ? { installationLockHeld: true } : {};
  const sync = await inspectProductComponentMode("sync");
  if (sync.state !== "not-created" && sync.state !== "not-installed") {
    await setProductComponentMode("sync", "disabled", modeOptions);
  }
  const core = await inspectProductComponentMode("core");
  if (core.state !== "not-installed") {
    await setProductComponentMode("core", "on-demand", modeOptions);
  }
  const afterModeChange = await inspectLocalCore(config);
  if (afterModeChange.running && afterModeChange.managed) {
    const stopped = await stopLocalCore({ config });
    if (stopped.running) {
      throw new Error("Cinba Core did not stop before uninstall");
    }
  }
}

function currentProductPaths(): ProductPaths {
  return resolveProductPaths({
    platform: supportedPlatform(),
    homeDirectory: homedir(),
    environment: process.env,
  });
}

const UNINSTALL_HELPER_LOG = "uninstall-helper.log";
const REPORTED_UNINSTALL_HELPER_LOG = "uninstall-helper.reported.log";

export async function launchUninstallHelper(
  options: { purge: boolean; blockingProcessId?: number },
  dependencies: { paths?: ProductPaths; spawnHelper?: typeof spawn } = {},
): Promise<void> {
  const paths = dependencies.paths ?? currentProductPaths();
  const directory = await mkdtemp(join(tmpdir(), "cinba-uninstall-"));
  const helper = join(
    directory,
    process.platform === "win32" ? "cinba-helper.exe" : "cinba-helper",
  );
  let child: ChildProcess | undefined;
  try {
    await copyFile(process.execPath, helper);
    if (process.platform !== "win32") {
      await chmod(helper, 0o755);
    }
    child = (dependencies.spawnHelper ?? spawn)(
      helper,
      [
        "__uninstall-helper",
        String(process.pid),
        options.purge ? "purge" : "normal",
        ...(options.blockingProcessId ? [String(options.blockingProcessId)] : []),
      ],
      {
        detached: true,
        // A surface reads this launcher's stderr until it closes; an inherited pipe held by the
        // helper would stay open until the surface itself exits, which the helper waits for.
        stdio: options.blockingProcessId ? "ignore" : "inherit",
        windowsHide: true,
      },
    );
    const spawned = child;
    await new Promise<void>((resolve, reject) => {
      spawned.once("spawn", resolve);
      spawned.once("error", reject);
    });
    if (!spawned.pid) {
      throw new Error("the Cinba uninstall helper did not start");
    }
    // The helper owns the installation lock so an installer waits instead of racing the removal.
    // It is never released here: deleting runtime state removes it, and a dead helper's lock is
    // reclaimed by the next installation.
    await acquireInstallationLock(paths, { processId: spawned.pid });
    spawned.unref();
  } catch (error) {
    child?.kill();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    throw error;
  }
}

/**
 * Uninstall requested from a running Desktop or TUI. That surface cannot remove itself, so this
 * refuses active Core work while it can still report back, stops the services, and leaves the
 * removal to a detached helper that first waits for the surface to exit. A requesting Desktop is
 * not force-stopped here: it would take its own quit handling with it, and the helper stops any
 * leftovers once the Desktop process is gone.
 */
export async function beginForegroundUninstall(
  options: { surface: "desktop" | "tui"; blockingProcessId: number; purge: boolean },
  dependencies: {
    processIsAlive?: (processId: number) => boolean;
    stopProduct?: typeof stopProductForUninstall;
    launchHelper?: typeof launchUninstallHelper;
  } = {},
): Promise<void> {
  if (!(dependencies.processIsAlive ?? processExists)(options.blockingProcessId)) {
    throw new Error("the Cinba process that requested the uninstall is not running");
  }
  await (dependencies.stopProduct ?? stopProductForUninstall)({
    stopDesktop: options.surface !== "desktop",
  });
  await (dependencies.launchHelper ?? launchUninstallHelper)({
    purge: options.purge,
    blockingProcessId: options.blockingProcessId,
  });
}

async function removeProductIntegrations(platform: SupportedPlatform): Promise<void> {
  const homeDirectory = homedir();
  const paths = resolveProductPaths({ platform, homeDirectory, environment: process.env });
  const failures: unknown[] = [];
  if (platform === "win32") {
    for (const operation of [
      () => removeWindowsProductIntegration({}),
      () => removeWindowsUserPath({ launcherDirectory: paths.launcherDirectory }),
    ]) {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    }
  } else {
    for (const profile of [join(homeDirectory, ".bashrc"), join(homeDirectory, ".zshrc")]) {
      try {
        await removePosixLauncherPathBlock(profile);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  for (const failure of failures) {
    console.warn(
      `[cinba] Could not remove one shell integration: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
  }
}

async function removeProduct(platform: SupportedPlatform, purge: boolean): Promise<void> {
  await removeProductIntegrations(platform);
  const plan = createUninstallPlan(
    { platform, homeDirectory: homedir(), environment: process.env },
    purge
      ? {
          mode: "purge",
          authorization: { kind: "non-interactive", deleteAllCinbaData: true },
        }
      : { mode: "normal" },
  );
  const result = await executeUninstallPlan(plan);
  if (result.failed.length > 0) {
    throw new Error(
      `Cinba uninstall could not remove: ${result.failed.map(({ target }) => target.kind).join(", ")}`,
    );
  }
}

/**
 * A surface-initiated helper runs detached with no output, so its failure is recorded where the
 * next launch can report it. Both uninstall modes remove the log directory, so a log left behind
 * means the uninstall did not finish.
 */
async function recordUninstallHelperFailure(paths: ProductPaths, error: unknown): Promise<void> {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  try {
    await mkdir(paths.logDirectory, { recursive: true });
    await appendFile(
      join(paths.logDirectory, UNINSTALL_HELPER_LOG),
      `${new Date().toISOString()} uninstall failed: ${detail}\n`,
    );
  } catch {
    // Nothing else could report it; the original error is still thrown.
  }
}

/** Reports, once, a failure recorded by an earlier uninstall helper. */
export async function reportPreviousUninstallFailure(
  paths: ProductPaths,
  warn: (message: string) => void = console.warn,
): Promise<void> {
  const reported = join(paths.logDirectory, REPORTED_UNINSTALL_HELPER_LOG);
  try {
    await rename(join(paths.logDirectory, UNINSTALL_HELPER_LOG), reported);
  } catch {
    return;
  }
  warn(`[cinba] The last Cinba uninstall did not finish. Details: ${reported}`);
}

export async function runUninstallHelper(
  options: { parentProcessId: number; purge: boolean; blockingProcessId?: number },
  dependencies: {
    paths?: ProductPaths;
    stopProduct?: typeof stopProductForUninstall;
    removeProduct?: (platform: SupportedPlatform, purge: boolean) => Promise<void>;
  } = {},
): Promise<void> {
  const platform = supportedPlatform();
  const paths = dependencies.paths ?? currentProductPaths();
  try {
    await waitForParentExit(options.parentProcessId);
    if (options.blockingProcessId) {
      await waitForParentExit(options.blockingProcessId, "the Cinba Desktop or TUI");
      // The launcher took the installation lock for this helper so a reinstall waits for the
      // removal; the service mode changes below run under that lock instead of taking it again.
      if (!(await installationLockHeldBy(paths, process.pid))) {
        throw new Error("the Cinba uninstall helper does not hold the installation lock");
      }
      // The surface may have reconnected to Core before it exited, and a requesting Desktop was
      // left running; this helper is a copy outside the install, so stopping Desktop spares it.
      await (dependencies.stopProduct ?? stopProductForUninstall)({ installationLockHeld: true });
    }
    await (dependencies.removeProduct ?? removeProduct)(platform, options.purge);
    console.log(
      options.purge
        ? "Cinba and all Cinba data were removed."
        : "Cinba was removed. User data was preserved.",
    );
  } catch (error) {
    await recordUninstallHelperFailure(paths, error);
    throw error;
  } finally {
    const helperDirectory = dirname(process.execPath);
    // Only a copied helper removes its own directory, never the runtime it was started from.
    if (basename(helperDirectory).startsWith("cinba-uninstall-")) {
      if (platform === "win32") {
        scheduleWindowsHelperDirectoryRemoval(helperDirectory);
      } else {
        await rm(helperDirectory, { recursive: true, force: true });
      }
    }
  }
}
