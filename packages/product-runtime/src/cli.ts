import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type LocalCoreConfig,
  ensureLocalCore,
  inspectLocalCore,
  stopLocalCore,
} from "@cinba/core-manager";
import { type ServiceMode, requireProductTarget, resolveProductPaths } from "@cinba/installer";
import {
  CINBA_UPDATE_STATE_DIRECTORY_ENV,
  checkForProductUpdatesAutomatically,
} from "./automatic-update.ts";
import { resolveProductPayloadLayout } from "./layout.ts";
import { formatInstalledDoctorReport, runInstalledDoctor } from "./doctor.ts";
import {
  formatProductComponentMode,
  inspectProductComponentMode,
  setProductComponentMode,
} from "./managed-services.ts";
import { readProductRelease } from "./release.ts";
import {
  createManagedSyncControl,
  createManagedSyncControlConfig,
  removeManagedSyncControl,
} from "./sync-control.ts";

export type ProductCommand =
  | { type: "tui"; workingDirectory: string }
  | { type: "core"; action: "status" | "start" | "stop" }
  | { type: "sync"; action: "serve" }
  | { type: "component-mode"; component: ProductServiceComponent; mode: ServiceMode | null }
  | { type: "service"; component: ProductServiceComponent }
  | { type: "doctor" }
  | { type: "version" }
  | { type: "help" };

export type ProductServiceComponent = "core" | "sync";

export type ProductCliDependencies = {
  readRelease: typeof readProductRelease;
  checkForUpdates: typeof checkForProductUpdatesAutomatically;
  executeCommand?: (command: ProductCommand) => Promise<void>;
};

export type ProductServiceProcess = {
  component: ProductServiceComponent;
  entry: string;
  workingDirectory: string;
  environment: NodeJS.ProcessEnv;
  controlStateDirectory?: string;
};

const HELP = `Cinba

Usage:
  cinba [project]
  cinba tui [project]
  cinba core <status|start|stop>
  cinba core mode [on-demand|background]
  cinba sync serve
  cinba sync mode [disabled|on-demand|background]
  cinba update
  cinba uninstall [--purge]
  cinba doctor
  cinba version
  cinba help

Commands:
  tui       Open the terminal client; defaults to the current project
  core      Inspect, start, or gracefully stop the local Core
  sync      Run Cinba Sync in the foreground
  mode      Inspect or change a component's lifecycle mode
  update    Check, download, and optionally install a product update
  uninstall Remove Cinba; --purge also deletes all Cinba data after confirmation
  doctor    Verify the installed release, runtime, and services
  version   Show the installed product version and revision
  help      Show this help

Options:
  -h, --help     Show this help
  -v, --version  Show the installed product version and revision`;

export function formatProductHelp(): string {
  return HELP;
}

export function parseProductCommand(
  arguments_: readonly string[],
  workingDirectory: string,
): ProductCommand {
  if (arguments_.length === 0) {
    return { type: "tui", workingDirectory: resolve(workingDirectory) };
  }
  if (
    arguments_.length === 1 &&
    (arguments_[0] === "help" || arguments_[0] === "--help" || arguments_[0] === "-h")
  ) {
    return { type: "help" };
  }
  if (
    arguments_.length === 1 &&
    (arguments_[0] === "version" || arguments_[0] === "--version" || arguments_[0] === "-v")
  ) {
    return { type: "version" };
  }
  if (arguments_.length === 1 && arguments_[0] === "doctor") {
    return { type: "doctor" };
  }
  if (arguments_[0] === "tui" && arguments_.length <= 2) {
    return {
      type: "tui",
      workingDirectory: resolve(arguments_[1] ?? workingDirectory),
    };
  }
  if (
    arguments_.length === 2 &&
    arguments_[0] === "core" &&
    (arguments_[1] === "status" || arguments_[1] === "start" || arguments_[1] === "stop")
  ) {
    return { type: "core", action: arguments_[1] };
  }
  if (arguments_.length === 2 && arguments_[0] === "sync" && arguments_[1] === "serve") {
    return { type: "sync", action: "serve" };
  }
  if (
    (arguments_[0] === "core" || arguments_[0] === "sync") &&
    arguments_[1] === "mode" &&
    arguments_.length >= 2 &&
    arguments_.length <= 3
  ) {
    const component = arguments_[0];
    const mode = arguments_[2] ?? null;
    const allowed =
      component === "core"
        ? new Set(["on-demand", "background"])
        : new Set(["disabled", "on-demand", "background"]);
    if (mode !== null && !allowed.has(mode)) {
      throw new Error(`${component} does not support mode ${mode}`);
    }
    return { type: "component-mode", component, mode: mode as ServiceMode | null };
  }
  if (
    arguments_.length === 2 &&
    arguments_[0] === "service" &&
    (arguments_[1] === "core" || arguments_[1] === "sync")
  ) {
    return { type: "service", component: arguments_[1] };
  }
  if (arguments_.length === 1) {
    return { type: "tui", workingDirectory: resolve(arguments_[0]!) };
  }
  throw new Error("run 'cinba help' for usage");
}

export function createProductTuiEnvironment(
  stateDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    [CINBA_UPDATE_STATE_DIRECTORY_ENV]: stateDirectory,
  };
}

export function createProductServiceProcess(
  payloadRoot: string,
  revision: string,
  component: ProductServiceComponent,
  options: {
    homeDirectory?: string;
    environment?: NodeJS.ProcessEnv;
    platform?: "win32" | "darwin" | "linux";
    managedService?: boolean;
  } = {},
): ProductServiceProcess {
  const environment = { ...(options.environment ?? process.env) };
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`Cinba is not available on ${platform}`);
  }
  const payload = resolveProductPayloadLayout(payloadRoot, platform);
  const productJoin = platform === "win32" ? win32.join : posix.join;
  const paths = resolveProductPaths({
    platform,
    homeDirectory: options.homeDirectory ?? homedir(),
    environment,
  });
  if (component === "core") {
    delete environment.CINBA_LOCAL_CONTROL_TOKEN;
    return {
      component,
      entry: payload.coreEntry,
      workingDirectory: payload.root,
      environment: {
        ...environment,
        ELECTRON_RUN_AS_NODE: "1",
        CINBA_CORE_LIFETIME: "persistent",
        CINBA_REVISION: revision,
        CINBA_PORT: "4517",
        CINBA_STATE_DIR: productJoin(paths.dataDirectory, "Core"),
        PI_CODING_AGENT_DIR: productJoin(paths.dataDirectory, "Pi"),
        CINBA_EXTENSION_ROOT: payload.extensionRoot,
        CINBA_WEB_ROOT: payload.webRoot,
      },
    };
  }
  delete environment.CINBA_LOCAL_SYNC_CONTROL_TOKEN;
  return {
    component,
    entry: payload.syncEntry,
    workingDirectory: payload.root,
    environment: {
      ...environment,
      ELECTRON_RUN_AS_NODE: "1",
      CINBA_SYNC_HOST: "127.0.0.1",
      CINBA_SYNC_PORT: "4518",
      CINBA_SYNC_PUBLIC_ORIGIN: "http://127.0.0.1:4518",
      CINBA_SYNC_STATE_DIR: paths.syncDataDirectory,
      CINBA_SYNC_WEB_ROOT: payload.syncWebRoot,
    },
    ...(options.managedService ? { controlStateDirectory: paths.stateDirectory } : {}),
  };
}

export function createProductCoreConfig(
  payloadRoot: string,
  options: {
    homeDirectory?: string;
    environment?: NodeJS.ProcessEnv;
    platform?: "win32" | "darwin" | "linux";
  } = {},
): LocalCoreConfig {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`Cinba is not available on ${platform}`);
  }
  const environment = options.environment ?? process.env;
  const paths = resolveProductPaths({
    platform,
    homeDirectory: options.homeDirectory ?? homedir(),
    environment,
  });
  const payload = resolveProductPayloadLayout(payloadRoot, platform);
  const productJoin = platform === "win32" ? win32.join : posix.join;
  return {
    baseUrl: "http://127.0.0.1:4517/",
    repositoryRoot: payload.root,
    serverEntry: payload.coreEntry,
    stateDirectory: productJoin(paths.dataDirectory, "Core"),
    piAgentDirectory: productJoin(paths.dataDirectory, "Pi"),
    startLockPath: productJoin(paths.stateDirectory, "core-start.lock"),
    runtimePath: productJoin(paths.stateDirectory, "core-runtime.json"),
    controlPath: productJoin(paths.stateDirectory, "core-control.json"),
    logPath: productJoin(paths.logDirectory, "core.log"),
    environment: {
      CINBA_EXTENSION_ROOT: payload.extensionRoot,
      CINBA_WEB_ROOT: payload.webRoot,
    },
  };
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`process stopped by ${signal}`));
      } else {
        resolvePromise(code ?? 0);
      }
    });
  });
}

function waitForServiceExit(child: ChildProcess): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const forward = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    for (const signal of signals) {
      process.on(signal, forward);
    }
    const cleanup = () => {
      for (const signal of signals) {
        process.off(signal, forward);
      }
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (code !== null) {
        resolvePromise(code);
      } else if (signal === "SIGINT" || signal === "SIGTERM") {
        resolvePromise(0);
      } else {
        reject(new Error(`service stopped by ${signal ?? "an unknown signal"}`));
      }
    });
  });
}

async function runProductService(service: ProductServiceProcess): Promise<void> {
  const syncControl =
    service.component === "sync" && service.controlStateDirectory
      ? {
          config: createManagedSyncControlConfig(service.controlStateDirectory),
          token: randomUUID(),
        }
      : undefined;
  const child = spawn(process.execPath, [service.entry], {
    cwd: service.workingDirectory,
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...service.environment,
      ...(syncControl ? { CINBA_LOCAL_SYNC_CONTROL_TOKEN: syncControl.token } : {}),
    },
  });
  const exit = waitForServiceExit(child);
  if (syncControl) {
    if (!child.pid) {
      child.kill();
      await exit.catch(() => undefined);
      throw new Error("Cinba Sync did not report a PID");
    }
    try {
      await createManagedSyncControl({
        config: syncControl.config,
        pid: child.pid,
        token: syncControl.token,
      });
    } catch (error) {
      child.kill();
      await exit.catch(() => undefined);
      throw error;
    }
  }
  let code: number;
  try {
    code = await exit;
  } finally {
    if (syncControl && child.pid) {
      await removeManagedSyncControl(syncControl.config, child.pid);
    }
  }
  if (code !== 0) {
    throw new Error(`Cinba ${service.component} exited with code ${code}`);
  }
}

function formatCoreStatus(status: Awaited<ReturnType<typeof inspectLocalCore>>): string {
  if (!status.running) {
    return "Cinba Core: stopped";
  }
  return `Cinba Core: ${status.state}\n  Lifecycle: ${status.lifetime ?? "external"}`;
}

export async function runProductCli(
  arguments_: readonly string[] = process.argv.slice(2),
  workingDirectory = process.cwd(),
  overrides: Partial<ProductCliDependencies> = {},
): Promise<void> {
  const dependencies: ProductCliDependencies = {
    readRelease: readProductRelease,
    checkForUpdates: checkForProductUpdatesAutomatically,
    ...overrides,
  };
  const payloadRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const payload = resolveProductPayloadLayout(payloadRoot);
  const release = await dependencies.readRelease(payload.root);
  if (release.target !== requireProductTarget()) {
    throw new Error(`this ${release.target} release cannot run on the current platform`);
  }
  const command = parseProductCommand(arguments_, workingDirectory);
  if (command.type === "tui") {
    const controller = new AbortController();
    const platform = process.platform;
    if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
      throw new Error(`Cinba is not available on ${platform}`);
    }
    const paths = resolveProductPaths({
      platform,
      homeDirectory: homedir(),
      environment: process.env,
    });
    const automaticUpdate = dependencies
      .checkForUpdates({ release, paths, signal: controller.signal })
      .catch(() => undefined);
    try {
      if (dependencies.executeCommand) {
        await dependencies.executeCommand(command);
        return;
      }
      const config = createProductCoreConfig(payload.root);
      await ensureLocalCore({ config, expectedRevision: release.revision });
      const code = await waitForExit(
        spawn(process.execPath, [payload.tuiEntry], {
          cwd: command.workingDirectory,
          stdio: "inherit",
          windowsHide: true,
          env: createProductTuiEnvironment(paths.stateDirectory),
        }),
      );
      if (code !== 0) {
        throw new Error(`Cinba terminal exited with code ${code}`);
      }
      return;
    } finally {
      controller.abort();
      await automaticUpdate;
    }
  }
  if (dependencies.executeCommand) {
    await dependencies.executeCommand(command);
    return;
  }
  if (command.type === "help") {
    console.log(formatProductHelp());
    return;
  }
  if (command.type === "version") {
    console.log(`Cinba ${release.version} (${release.revision})`);
    return;
  }
  if (command.type === "doctor") {
    const report = await runInstalledDoctor(payload.root);
    console.log(formatInstalledDoctorReport(report));
    if (!report.healthy) {
      process.exitCode = 1;
    }
    return;
  }

  const config = createProductCoreConfig(payload.root);
  if (command.type === "component-mode") {
    const status = command.mode
      ? await setProductComponentMode(command.component, command.mode)
      : await inspectProductComponentMode(command.component);
    console.log(formatProductComponentMode(status));
    return;
  }
  if (command.type === "service") {
    await runProductService(
      createProductServiceProcess(payload.root, release.revision, command.component, {
        managedService: true,
      }),
    );
    return;
  }
  if (command.type === "core") {
    if (command.action === "status") {
      console.log(formatCoreStatus(await inspectLocalCore(config)));
    } else if (command.action === "start") {
      console.log(
        formatCoreStatus(await ensureLocalCore({ config, expectedRevision: release.revision })),
      );
    } else {
      console.log(formatCoreStatus(await stopLocalCore({ config })));
    }
    return;
  }
  if (command.type === "sync") {
    await runProductService(createProductServiceProcess(payload.root, release.revision, "sync"));
    return;
  }
}

if (import.meta.main) {
  runProductCli().catch((error: unknown) => {
    console.error(`[cinba] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
