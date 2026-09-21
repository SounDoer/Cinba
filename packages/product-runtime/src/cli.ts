import { type ChildProcess, spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { ensureLocalCore, inspectLocalCore, stopLocalCore } from "@cinba/core-manager";
import { type ServiceMode, requireProductTarget, resolveProductPaths } from "@cinba/installer";
import {
  CINBA_UPDATE_STATE_DIRECTORY_ENV,
  checkForProductUpdatesAutomatically,
} from "./automatic-update.ts";
import { resolveProductPayloadLayout } from "./layout.ts";
import { formatInstalledDoctorReport, runInstalledDoctor } from "./doctor.ts";
import { createInstalledSyncHostManager } from "./installed-sync-host.ts";
import {
  formatProductComponentMode,
  inspectProductComponentMode,
  setProductComponentMode,
} from "./managed-services.ts";
import { readProductRelease } from "./release.ts";
import {
  type ProductServiceComponent,
  createProductCoreConfig,
  createProductServiceProcess,
  runProductService,
} from "./product-service.ts";
import { type SyncHostConfig, readSyncHostConfig, syncHostConfigPath } from "./sync-host-config.ts";
import {
  type ProductSyncHostCreation,
  type ProductSyncHostStatus,
  configureProductSyncHost,
  formatProductSyncHostStatus,
  inspectProductSyncHost,
  setProductSyncHostMode,
} from "./sync-host-manager.ts";

export type ProductCommand =
  | { type: "tui"; workingDirectory: string }
  | { type: "core"; action: "status" | "start" | "stop" }
  | { type: "sync"; action: "serve" }
  | { type: "sync-host-create"; publicOrigin: string | undefined; showSetupCode: boolean }
  | { type: "sync-host-delete"; confirmed: boolean }
  | { type: "sync-host-status"; json: boolean }
  | { type: "sync-host-configure"; publicOrigin: string }
  | { type: "component-mode"; component: ProductServiceComponent; mode: ServiceMode | null }
  | { type: "service"; component: ProductServiceComponent }
  | { type: "doctor" }
  | { type: "version" }
  | { type: "help" };

export type { ProductServiceComponent, ProductServiceProcess } from "./product-service.ts";
export { createProductCoreConfig, createProductServiceProcess } from "./product-service.ts";

export type ProductCliDependencies = {
  readRelease: typeof readProductRelease;
  checkForUpdates: typeof checkForProductUpdatesAutomatically;
  createInstalledSyncHostManager: typeof createInstalledSyncHostManager;
  configureSyncHost: typeof configureProductSyncHost;
  createSyncHost?: (publicOrigin?: string) => Promise<ProductSyncHostCreation>;
  deleteSyncHost?: () => Promise<ProductSyncHostStatus>;
  confirmSyncHostDelete?: () => Promise<boolean>;
  inspectSyncHost: typeof inspectProductSyncHost;
  setSyncHostMode: typeof setProductSyncHostMode;
  writeOutput: (output: string) => void;
  executeCommand?: (command: ProductCommand) => Promise<void>;
};

const HELP = `Cinba

Usage:
  cinba [project]
  cinba tui [project]
  cinba core <status|start|stop>
  cinba core mode [on-demand|background]
  cinba sync serve
  cinba sync create [--public-origin URL] [--show-setup-code]
  cinba sync configure --public-origin URL
  cinba sync delete [--confirm-delete-host]
  cinba sync status [--json]
  cinba sync mode [disabled|on-demand|background]
  cinba update
  cinba uninstall [--purge]
  cinba doctor
  cinba version
  cinba help

Commands:
  tui       Open the terminal client; defaults to the current project
  core      Inspect, start, or gracefully stop the local Core
  sync      Inspect or run the local Cinba Sync Host
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

function parseSyncHostCreate(arguments_: readonly string[]): ProductCommand | undefined {
  if (arguments_[0] !== "sync" || arguments_[1] !== "create") {
    return undefined;
  }
  let publicOrigin: string | undefined;
  let showSetupCode = false;
  for (let index = 2; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--show-setup-code" && !showSetupCode) {
      showSetupCode = true;
      continue;
    }
    if (argument === "--public-origin" && publicOrigin === undefined) {
      publicOrigin = arguments_[index + 1];
      if (!publicOrigin) {
        throw new Error("run 'cinba help' for usage");
      }
      index += 1;
      continue;
    }
    throw new Error("run 'cinba help' for usage");
  }
  return { type: "sync-host-create", publicOrigin, showSetupCode };
}

function parseSyncHostDelete(arguments_: readonly string[]): ProductCommand | undefined {
  if (arguments_[0] !== "sync" || arguments_[1] !== "delete") {
    return undefined;
  }
  if (
    arguments_.length !== 2 &&
    !(arguments_.length === 3 && arguments_[2] === "--confirm-delete-host")
  ) {
    throw new Error("run 'cinba help' for usage");
  }
  return { type: "sync-host-delete", confirmed: arguments_.length === 3 };
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
  const syncHostCreate = parseSyncHostCreate(arguments_);
  if (syncHostCreate) {
    return syncHostCreate;
  }
  const syncHostDelete = parseSyncHostDelete(arguments_);
  if (syncHostDelete) {
    return syncHostDelete;
  }
  if (
    arguments_[0] === "sync" &&
    arguments_[1] === "status" &&
    (arguments_.length === 2 || (arguments_.length === 3 && arguments_[2] === "--json"))
  ) {
    return { type: "sync-host-status", json: arguments_[2] === "--json" };
  }
  if (
    arguments_.length === 4 &&
    arguments_[0] === "sync" &&
    arguments_[1] === "configure" &&
    arguments_[2] === "--public-origin"
  ) {
    return { type: "sync-host-configure", publicOrigin: arguments_[3]! };
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
    createInstalledSyncHostManager,
    configureSyncHost: configureProductSyncHost,
    inspectSyncHost: inspectProductSyncHost,
    setSyncHostMode: setProductSyncHostMode,
    writeOutput: (output) => console.log(output),
    ...overrides,
  };
  const payloadRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const payload = resolveProductPayloadLayout(payloadRoot);
  const release = await dependencies.readRelease(payload.root);
  if (release.target !== requireProductTarget()) {
    throw new Error(`this ${release.target} release cannot run on the current platform`);
  }
  const installedSyncHost = dependencies.createInstalledSyncHostManager(payload.root, release);
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
      const config = createProductCoreConfig(payload.root, { release });
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
  if (command.type === "sync-host-status") {
    const status = await dependencies.inspectSyncHost();
    dependencies.writeOutput(
      command.json ? JSON.stringify(status) : formatProductSyncHostStatus(status),
    );
    return;
  }
  if (command.type === "sync-host-configure") {
    dependencies.writeOutput(
      formatProductSyncHostStatus(await dependencies.configureSyncHost(command.publicOrigin)),
    );
    return;
  }
  if (command.type === "sync-host-create") {
    const creation = dependencies.createSyncHost
      ? await dependencies.createSyncHost(command.publicOrigin)
      : await installedSyncHost.create(command.publicOrigin);
    dependencies.writeOutput(formatProductSyncHostStatus(creation.status));
    if (creation.setupCode && (command.showSetupCode || process.stdout.isTTY)) {
      dependencies.writeOutput(`Setup Code: ${creation.setupCode}`);
    }
    return;
  }
  if (command.type === "sync-host-delete") {
    const confirmed =
      command.confirmed ||
      (await (dependencies.confirmSyncHostDelete ?? askSyncHostDeleteConfirmation)());
    if (!confirmed) {
      throw new Error(
        "Sync Host deletion was not confirmed; use an interactive terminal or --confirm-delete-host",
      );
    }
    const status = dependencies.deleteSyncHost
      ? await dependencies.deleteSyncHost()
      : await installedSyncHost.delete();
    dependencies.writeOutput(formatProductSyncHostStatus(status));
    return;
  }
  if (command.type === "component-mode" && command.component === "sync") {
    const status = command.mode
      ? await dependencies.setSyncHostMode(
          command.mode,
          process.stdin.isTTY && process.stdout.isTTY ? { authorizeLinger: askLingerConsent } : {},
        )
      : await dependencies.inspectSyncHost();
    dependencies.writeOutput(formatProductSyncHostStatus(status));
    return;
  }

  const config = createProductCoreConfig(payload.root, { release });
  if (command.type === "component-mode") {
    const status = command.mode
      ? await setProductComponentMode(command.component, command.mode, {
          localCore: { config },
          ...(process.stdin.isTTY && process.stdout.isTTY
            ? { authorizeLinger: askLingerConsent }
            : {}),
        })
      : await inspectProductComponentMode(command.component);
    console.log(formatProductComponentMode(status));
    return;
  }
  if (command.type === "service") {
    const syncHostConfig =
      command.component === "sync" ? await readInstalledSyncHostConfig() : undefined;
    await runProductService(
      createProductServiceProcess(payload.root, release, command.component, {
        managedService: true,
        ...(syncHostConfig ? { syncHostConfig } : {}),
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
    const syncHostConfig = await readInstalledSyncHostConfig();
    await runProductService(
      createProductServiceProcess(
        payload.root,
        release,
        "sync",
        syncHostConfig ? { syncHostConfig } : undefined,
      ),
    );
    return;
  }
}

async function readInstalledSyncHostConfig(): Promise<SyncHostConfig | undefined> {
  const platform = process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`Cinba is not available on ${platform}`);
  }
  const paths = resolveProductPaths({
    platform,
    homeDirectory: homedir(),
    environment: process.env,
  });
  return await readSyncHostConfig(syncHostConfigPath(paths));
}

async function askLingerConsent(userName: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(
      `Background needs linger for user ${userName} so Cinba keeps running after logout and restarts.`,
    );
    console.log(
      `Cinba can run 'loginctl enable-linger ${userName}' now; the system may ask for an administrator password.`,
    );
    const answer = await prompt.question("Enable linger? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function askSyncHostDeleteConfirmation(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Deleting this Sync Host permanently removes its trust root and shared data.");
    const answer = await prompt.question('Type "DELETE SYNC HOST" to continue: ');
    return answer.trim() === "DELETE SYNC HOST";
  } finally {
    prompt.close();
  }
}

if (import.meta.main) {
  runProductCli().catch((error: unknown) => {
    console.error(`[cinba] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
