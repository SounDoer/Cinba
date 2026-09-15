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
import { launchDesktop, launchTui } from "./launch.ts";
import { formatDoctorReport, runDoctor } from "./doctor.ts";

const COMMAND_PATH = fileURLToPath(import.meta.url);

export type CinbaCommand =
  | { type: "tui"; workingDirectory: string }
  | { type: "core"; action: "status" | "start" | "stop" }
  | { type: "doctor"; workingDirectory: string }
  | { type: "desktop" }
  | { type: "help" };

const HELP = `Cinba

Usage:
  cinba [project]
  cinba tui [project]
  cinba core <status|start|stop>
  cinba desktop
  cinba doctor [project]
  cinba help

Commands:
  tui       Open the terminal client; defaults to the current project
  core      Inspect, start, or gracefully stop the shared local Core
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
  throw new Error("run 'cinba help' for usage");
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
    console.log("Cinba Desktop is running.");
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
