#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMAND_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = dirname(dirname(COMMAND_PATH));
const LAUNCHER_PATH = join(REPOSITORY_ROOT, "scripts", "launch.ts");

export function tuiProcessArguments(workingDirectory: string): string[] {
  return [process.execPath, LAUNCHER_PATH, "tui", resolve(workingDirectory)];
}

async function main(): Promise<void> {
  process.argv = tuiProcessArguments(process.cwd());
  await import("./launch.ts");
}

if (process.argv[1] && COMMAND_PATH === resolve(process.argv[1])) {
  await main();
}
