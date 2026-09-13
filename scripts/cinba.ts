#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type LocalCoreStatus,
  ensureLocalCore,
  inspectLocalCore,
  stopLocalCore,
} from "@cinba/core-manager";
import { launchTui } from "./launch.ts";

const COMMAND_PATH = fileURLToPath(import.meta.url);

export type CinbaCommand =
  { type: "tui"; workingDirectory: string } | { type: "core"; action: "status" | "start" | "stop" };

export function parseCinbaCommand(arguments_: string[], workingDirectory: string): CinbaCommand {
  if (arguments_.length === 0) {
    return { type: "tui", workingDirectory: resolve(workingDirectory) };
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
  if (arguments_.length === 1 && arguments_[0] !== "core") {
    return { type: "tui", workingDirectory: resolve(arguments_[0]) };
  }
  throw new Error("usage: cinba [tui] [project] | cinba core <status|start|stop>");
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
  const command = parseCinbaCommand(
    process.argv.slice(2),
    process.env.CINBA_DEFAULT_PROJECT ?? process.cwd(),
  );
  if (command.type === "tui") {
    await launchTui(command.workingDirectory);
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
