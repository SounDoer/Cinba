import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LocalCoreConfig = {
  baseUrl: string;
  repositoryRoot: string;
  serverEntry: string;
  stateDirectory: string;
  piAgentDirectory: string;
  startLockPath: string;
  runtimePath: string;
  controlPath: string;
  logPath: string;
};

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function createLocalCoreConfig(
  options: {
    homeDirectory?: string;
    packageRoot?: string;
    baseUrl?: string;
  } = {},
): LocalCoreConfig {
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const repositoryRoot = resolve(packageRoot, "..", "..");
  const homeDirectory = options.homeDirectory ?? homedir();
  const stateDirectory = join(homeDirectory, ".cinba");

  return {
    baseUrl: options.baseUrl ?? "http://127.0.0.1:4517/",
    repositoryRoot,
    serverEntry: join(repositoryRoot, "packages", "server", "src", "index.ts"),
    stateDirectory,
    piAgentDirectory: join(homeDirectory, ".pi", "agent"),
    startLockPath: join(stateDirectory, "core-start.lock"),
    runtimePath: join(stateDirectory, "core-runtime.json"),
    controlPath: join(stateDirectory, "core-control.json"),
    logPath: join(stateDirectory, "core.log"),
  };
}
