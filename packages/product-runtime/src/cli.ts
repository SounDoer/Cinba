import { type ChildProcess, spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type LocalCoreConfig,
  ensureLocalCore,
  inspectLocalCore,
  stopLocalCore,
} from "@cinba/core-manager";
import { requireProductTarget, resolveProductPaths } from "@cinba/installer";
import { resolveProductPayloadLayout } from "./layout.ts";
import { readProductRelease } from "./release.ts";

export type ProductCommand =
  | { type: "tui"; workingDirectory: string }
  | { type: "core"; action: "status" | "start" | "stop" }
  | { type: "sync"; action: "serve" }
  | { type: "version" }
  | { type: "help" };

const HELP = `Cinba

Usage:
  cinba [project]
  cinba tui [project]
  cinba core <status|start|stop>
  cinba sync serve
  cinba version
  cinba help

Commands:
  tui       Open the terminal client; defaults to the current project
  core      Inspect, start, or gracefully stop the local Core
  sync      Run Cinba Sync in the foreground
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
  if (arguments_.length === 1) {
    return { type: "tui", workingDirectory: resolve(arguments_[0]!) };
  }
  throw new Error("run 'cinba help' for usage");
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
  return {
    baseUrl: "http://127.0.0.1:4517/",
    repositoryRoot: payload.root,
    serverEntry: payload.coreEntry,
    stateDirectory: join(paths.dataDirectory, "Core"),
    piAgentDirectory: join(paths.dataDirectory, "Pi"),
    startLockPath: join(paths.stateDirectory, "core-start.lock"),
    runtimePath: join(paths.stateDirectory, "core-runtime.json"),
    controlPath: join(paths.stateDirectory, "core-control.json"),
    logPath: join(paths.logDirectory, "core.log"),
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

function formatCoreStatus(status: Awaited<ReturnType<typeof inspectLocalCore>>): string {
  if (!status.running) {
    return "Cinba Core: stopped";
  }
  return `Cinba Core: ${status.state}\n  Lifecycle: ${status.lifetime ?? "external"}`;
}

export async function runProductCli(
  arguments_: readonly string[] = process.argv.slice(2),
  workingDirectory = process.cwd(),
): Promise<void> {
  const payloadRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const payload = resolveProductPayloadLayout(payloadRoot);
  const release = await readProductRelease(payload.root);
  if (release.target !== requireProductTarget()) {
    throw new Error(`this ${release.target} release cannot run on the current platform`);
  }
  const command = parseProductCommand(arguments_, workingDirectory);
  if (command.type === "help") {
    console.log(formatProductHelp());
    return;
  }
  if (command.type === "version") {
    console.log(`Cinba ${release.version} (${release.revision})`);
    return;
  }

  const config = createProductCoreConfig(payload.root);
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
    const paths = resolveProductPaths({
      platform: process.platform as "win32" | "darwin" | "linux",
      homeDirectory: homedir(),
      environment: process.env,
    });
    const code = await waitForExit(
      spawn(process.execPath, [payload.syncEntry], {
        stdio: "inherit",
        windowsHide: true,
        env: {
          ...process.env,
          CINBA_SYNC_STATE_DIR: paths.syncDataDirectory,
          CINBA_SYNC_WEB_ROOT: payload.syncWebRoot,
        },
      }),
    );
    if (code !== 0) {
      throw new Error(`Cinba Sync exited with code ${code}`);
    }
    return;
  }

  await ensureLocalCore({ config, expectedRevision: release.revision });
  const code = await waitForExit(
    spawn(process.execPath, [payload.tuiEntry], {
      cwd: command.workingDirectory,
      stdio: "inherit",
      windowsHide: true,
      env: process.env,
    }),
  );
  if (code !== 0) {
    throw new Error(`Cinba terminal exited with code ${code}`);
  }
}

if (import.meta.main) {
  runProductCli().catch((error: unknown) => {
    console.error(`[cinba] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
