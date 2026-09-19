import { type ChildProcess, spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import { createInterface } from "node:readline/promises";
import { type LocalCoreConfig, inspectLocalCore, stopLocalCore } from "@cinba/core-manager";
import {
  acquireInstallationLock,
  createUninstallPlan,
  executeUninstallPlan,
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

async function waitForParentExit(processId: number): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (!processExists(processId)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the Cinba launcher did not exit in time");
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

export async function stopProductForUninstall(): Promise<void> {
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
  if (platform === "win32" && paths.desktopApplicationPath) {
    const stopped = await stopWindowsDesktopApplication({
      desktopApplicationPath: paths.desktopApplicationPath,
    });
    if (stopped > 0) {
      console.log("Cinba Desktop was closed.");
    }
  }

  const sync = await inspectProductComponentMode("sync");
  if (sync.state !== "not-created" && sync.state !== "not-installed") {
    await setProductComponentMode("sync", "disabled");
  }
  const core = await inspectProductComponentMode("core");
  if (core.state !== "not-installed") {
    await setProductComponentMode("core", "on-demand");
  }
  const afterModeChange = await inspectLocalCore(config);
  if (afterModeChange.running && afterModeChange.managed) {
    const stopped = await stopLocalCore({ config });
    if (stopped.running) {
      throw new Error("Cinba Core did not stop before uninstall");
    }
  }
}

export async function launchUninstallHelper(options: { purge: boolean }): Promise<void> {
  const paths = resolveProductPaths({
    platform: supportedPlatform(),
    homeDirectory: homedir(),
    environment: process.env,
  });
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
    child = spawn(
      helper,
      ["__uninstall-helper", String(process.pid), options.purge ? "purge" : "normal"],
      {
        detached: true,
        stdio: "inherit",
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

function scheduleWindowsHelperCleanup(helper: string): void {
  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      "Wait-Process -Id $env:CINBA_HELPER_PID -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $env:CINBA_HELPER_DIRECTORY -Recurse -Force -ErrorAction SilentlyContinue",
    ],
    {
      detached: true,
      env: {
        ...process.env,
        CINBA_HELPER_PID: String(process.pid),
        CINBA_HELPER_DIRECTORY: dirname(helper),
      },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.once("error", () => {});
  child.unref();
}

export async function runUninstallHelper(options: {
  parentProcessId: number;
  purge: boolean;
}): Promise<void> {
  const platform = supportedPlatform();
  try {
    await waitForParentExit(options.parentProcessId);
    const homeDirectory = homedir();
    await removeProductIntegrations(platform);
    const plan = createUninstallPlan(
      { platform, homeDirectory, environment: process.env },
      options.purge
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
    console.log(
      options.purge
        ? "Cinba and all Cinba data were removed."
        : "Cinba was removed. User data was preserved.",
    );
  } finally {
    const helper = process.execPath;
    if (platform === "win32") {
      scheduleWindowsHelperCleanup(helper);
    } else if (basename(dirname(helper)).startsWith("cinba-uninstall-")) {
      await rm(dirname(helper), { recursive: true, force: true });
    }
  }
}
