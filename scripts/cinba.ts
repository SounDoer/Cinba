#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMAND_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = dirname(dirname(COMMAND_PATH));
const LAUNCHER_PATH = join(REPOSITORY_ROOT, "scripts", "launch.ts");

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

async function main(): Promise<void> {
  process.argv = tuiProcessArguments(process.cwd());
  await import("./launch.ts");
}

if (process.argv[1] && isDirectExecution(COMMAND_PATH, process.argv[1])) {
  await main();
}
