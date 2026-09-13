#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type LocalCoreStatus,
  ensureLocalCore,
  inspectLocalCore,
  stopLocalCore,
} from "@cinba/core-manager";

const COMMAND_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = dirname(dirname(COMMAND_PATH));
const LAUNCHER_PATH = join(REPOSITORY_ROOT, "scripts", "launch.ts");

export type CinbaCommand =
  { type: "tui"; workingDirectory: string } | { type: "core"; action: "status" | "start" | "stop" };

export function parseCinbaCommand(arguments_: string[], workingDirectory: string): CinbaCommand {
  if (arguments_.length === 0) {
    return { type: "tui", workingDirectory: resolve(workingDirectory) };
  }
  if (
    arguments_.length === 2 &&
    arguments_[0] === "core" &&
    (arguments_[1] === "status" || arguments_[1] === "start" || arguments_[1] === "stop")
  ) {
    return { type: "core", action: arguments_[1] };
  }
  throw new Error("usage: cinba | cinba core <status|start|stop>");
}

export function tuiProcessArguments(workingDirectory: string): string[] {
  return [process.execPath, LAUNCHER_PATH, "tui", resolve(workingDirectory)];
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
    return "Cinba Core: stopped";
  }

  const lines = [`Cinba Core: ${status.state}`];
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
    inspect: typeof inspectLocalCore;
    ensure: typeof ensureLocalCore;
    stop: typeof stopLocalCore;
  } = { inspect: inspectLocalCore, ensure: ensureLocalCore, stop: stopLocalCore },
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
  const command = parseCinbaCommand(process.argv.slice(2), process.cwd());
  if (command.type === "tui") {
    process.argv = tuiProcessArguments(command.workingDirectory);
    await import("./launch.ts");
    return;
  }

  console.log(await runCoreCommand(command.action));
}

if (process.argv[1] && isDirectExecution(COMMAND_PATH, process.argv[1])) {
  try {
    await main();
  } catch (error) {
    console.error(`[cinba] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
