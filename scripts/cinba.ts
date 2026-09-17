#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type LocalCoreStatus,
  ensureLocalCore,
  inspectLocalCore,
  stopLocalCore,
} from "@cinba/core-manager";
import {
  backupSyncState,
  createSyncStore,
  defaultSyncStateDirectory,
  inspectSyncState,
  restoreSyncState,
  runSyncServer,
} from "@cinba/sync-server";
import {
  createDevelopmentCoreConfig,
  createDevelopmentSyncEnvironment,
} from "@cinba/product-runtime";
import { launchDesktop, launchTui } from "./launch.ts";
import { formatDoctorReport, runDoctor } from "./doctor.ts";

const COMMAND_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = dirname(dirname(COMMAND_PATH));

export type CinbaCommand =
  | { type: "tui"; workingDirectory: string }
  | { type: "core"; action: "status" | "start" | "stop" }
  | { type: "doctor"; workingDirectory: string }
  | { type: "desktop" }
  | {
      type: "sync";
      action: "serve" | "status" | "reset-password" | "backup" | "restore";
      path?: string;
      force?: boolean;
    }
  | { type: "help" };

const HELP = `Cinba Dev

Usage:
  cinba-dev [project]
  cinba-dev tui [project]
  cinba-dev core <status|start|stop>
  cinba-dev sync <serve|status|reset-password>
  cinba-dev sync backup <archive>
  cinba-dev sync restore <archive> [--force]
  cinba-dev desktop
  cinba-dev doctor [project]
  cinba-dev help

Commands:
  tui       Open the terminal client; defaults to the current project
  core      Inspect, start, or gracefully stop the shared local Core
  sync      Operate the local persistent Sync Server
  desktop   Run the Windows or macOS multi-Core Desktop client
  doctor    Check the runtime, checkout, project, and effective Core
  help      Show this help

Options:
  -h, --help  Show this help`;

export function formatHelp(): string {
  return HELP;
}

export function parseCinbaCommand(arguments_: string[], workingDirectory: string): CinbaCommand {
  if (arguments_.length === 0) {
    return { type: "tui", workingDirectory: resolve(workingDirectory) };
  }
  if (
    arguments_.length === 1 &&
    (arguments_[0] === "help" || arguments_[0] === "--help" || arguments_[0] === "-h")
  ) {
    return { type: "help" };
  }
  if (arguments_[0] === "sync") {
    const action = arguments_[1];
    if (
      arguments_.length === 2 &&
      (action === "serve" || action === "status" || action === "reset-password")
    ) {
      return { type: "sync", action };
    }
    if (action === "backup" && arguments_.length === 3) {
      return { type: "sync", action, path: resolve(arguments_[2]!) };
    }
    if (
      action === "restore" &&
      (arguments_.length === 3 || (arguments_.length === 4 && arguments_[3] === "--force"))
    ) {
      return {
        type: "sync",
        action,
        path: resolve(arguments_[2]!),
        force: arguments_[3] === "--force",
      };
    }
    throw new Error("run 'cinba-dev help' for usage");
  }
  if (arguments_.length === 1 && arguments_[0] === "desktop") {
    return { type: "desktop" };
  }
  if (arguments_[0] === "doctor" && arguments_.length <= 2) {
    return {
      type: "doctor",
      workingDirectory: resolve(arguments_[1] ?? workingDirectory),
    };
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
  if (arguments_.length === 1 && arguments_[0] !== "core" && arguments_[0] !== "doctor") {
    return { type: "tui", workingDirectory: resolve(arguments_[0]) };
  }
  throw new Error("run 'cinba-dev help' for usage");
}

function migrationPassword(environment: NodeJS.ProcessEnv): string {
  const password = environment.CINBA_SYNC_MIGRATION_PASSWORD;
  if (!password) {
    throw new Error("set CINBA_SYNC_MIGRATION_PASSWORD to a one-time migration password");
  }
  return password;
}

export async function runSyncCommand(
  command: Extract<CinbaCommand, { type: "sync" }>,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const directory = defaultSyncStateDirectory(environment);
  if (command.action === "serve") {
    const host = environment.CINBA_SYNC_HOST?.trim() || "127.0.0.1";
    const port = Number(environment.CINBA_SYNC_PORT ?? "4518");
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error("CINBA_SYNC_PORT must be an integer from 1 to 65535");
    }
    const publicOrigin = environment.CINBA_SYNC_PUBLIC_ORIGIN?.trim() || `http://${host}:${port}`;
    await runSyncServer({ stateDirectory: directory, host, port, publicOrigin });
    return undefined;
  }
  if (command.action === "status") {
    const status = inspectSyncState(directory);
    if (status.state === "absent") {
      return "Cinba Dev Sync: not initialized";
    }
    const lines = [`Cinba Dev Sync: ${status.state}`];
    if (status.serverId) {
      lines.push(`  Server ID: ${status.serverId}`);
    }
    if (status.setupCode) {
      lines.push(`  Setup Code: ${status.setupCode}`);
    }
    return lines.join("\n");
  }
  if (command.action === "reset-password") {
    const store = createSyncStore(directory);
    if (store.problem()) {
      throw store.problem();
    }
    const code = await store.resetAdministrator();
    return `Administrator password reset.\n  Setup Code: ${code}`;
  }
  if (command.action === "backup") {
    backupSyncState(directory, command.path!, migrationPassword(environment));
    return `Sync backup written to ${command.path}`;
  }
  const preserved = restoreSyncState(directory, command.path!, migrationPassword(environment), {
    force: command.force,
  });
  return preserved
    ? `Sync backup restored. Previous state preserved at ${preserved}`
    : "Sync backup restored.";
}

export function isDirectExecution(
  commandPath: string,
  argumentPath: string,
  canonicalize: (path: string) => string = realpathSync.native,
): boolean {
  return canonicalize(commandPath) === canonicalize(resolve(argumentPath));
}

export function formatCoreStatus(status: LocalCoreStatus): string {
  if (!status.running) {
    return "Cinba Dev Core: stopped";
  }

  const lines = [`Cinba Dev Core: ${status.state}`];
  if (status.pid !== undefined) {
    lines.push(`  PID: ${status.pid}`);
  }
  lines.push(`  Lifecycle: ${status.lifetime ?? "external"}`);
  if (status.clientCount !== undefined) {
    lines.push(`  Clients: ${status.clientCount}`);
  }
  if (status.safeToStop !== undefined) {
    lines.push(`  Safe to stop: ${status.safeToStop ? "yes" : "no"}`);
  }
  return lines.join("\n");
}

export async function runCoreCommand(
  action: "status" | "start" | "stop",
  manager: {
    inspect: () => Promise<LocalCoreStatus>;
    ensure: () => Promise<LocalCoreStatus>;
    stop: () => Promise<LocalCoreStatus>;
  } = {
    inspect: () => inspectLocalCore(),
    ensure: () => ensureLocalCore(),
    stop: () => stopLocalCore(),
  },
): Promise<string> {
  if (action === "status") {
    return formatCoreStatus(await manager.inspect());
  }
  if (action === "start") {
    return formatCoreStatus(await manager.ensure());
  }
  return formatCoreStatus(await manager.stop());
}

async function main(): Promise<void> {
  const command = parseCinbaCommand(
    process.argv.slice(2),
    process.env.CINBA_DEFAULT_PROJECT ?? process.cwd(),
  );
  if (command.type === "tui") {
    await launchTui(command.workingDirectory);
    return;
  }
  if (command.type === "help") {
    console.log(formatHelp());
    return;
  }
  if (command.type === "doctor") {
    const report = await runDoctor({
      projectDirectory: command.workingDirectory,
      serverUrl: process.env.CINBA_SERVER,
    });
    console.log(formatDoctorReport(report));
    if (!report.healthy) {
      process.exitCode = 1;
    }
    return;
  }
  if (command.type === "desktop") {
    await launchDesktop();
    console.log("Cinba Dev Desktop is running.");
    return;
  }
  if (command.type === "sync") {
    const result = await runSyncCommand(command, createDevelopmentSyncEnvironment());
    if (result) {
      console.log(result);
    }
    return;
  }

  const config = createDevelopmentCoreConfig(REPOSITORY_ROOT);
  console.log(
    await runCoreCommand(command.action, {
      inspect: () => inspectLocalCore(config),
      ensure: () => ensureLocalCore({ config }),
      stop: () => stopLocalCore({ config }),
    }),
  );
}

if (process.argv[1] && isDirectExecution(COMMAND_PATH, process.argv[1])) {
  try {
    await main();
  } catch (error) {
    console.error(`[cinba] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
