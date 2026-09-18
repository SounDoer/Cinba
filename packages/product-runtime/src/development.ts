import { homedir, hostname } from "node:os";
import { posix, win32 } from "node:path";
import type { LocalCoreConfig } from "@cinba/core-manager";
import { resolveProductPaths } from "@cinba/installer";

export function createDevelopmentCoreConfig(
  repositoryRoot: string,
  options: {
    homeDirectory?: string;
    environment?: NodeJS.ProcessEnv;
    machineName?: string;
    platform?: "win32" | "darwin" | "linux";
  } = {},
): LocalCoreConfig {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`Cinba Dev is not available on ${platform}`);
  }
  const environment = options.environment ?? process.env;
  const paths = resolveProductPaths({
    platform,
    homeDirectory: options.homeDirectory ?? homedir(),
    identity: "development",
    environment,
  });
  const pathImplementation = platform === "win32" ? win32 : posix;
  const root = pathImplementation.resolve(repositoryRoot);
  return {
    baseUrl: "http://127.0.0.1:4518/",
    repositoryRoot: root,
    serverEntry: pathImplementation.join(root, "packages", "server", "src", "index.ts"),
    stateDirectory: pathImplementation.join(paths.dataDirectory, "Core"),
    piAgentDirectory: pathImplementation.join(paths.dataDirectory, "Pi"),
    startLockPath: pathImplementation.join(paths.stateDirectory, "core-start.lock"),
    runtimePath: pathImplementation.join(paths.stateDirectory, "core-runtime.json"),
    controlPath: pathImplementation.join(paths.stateDirectory, "core-control.json"),
    logPath: pathImplementation.join(paths.logDirectory, "core.log"),
    defaultCoreName: `${options.machineName ?? hostname()} Dev`,
    environment: {
      CINBA_SYNC_SETTINGS_SOURCE: "sync",
      CINBA_SYNC_CREDENTIAL_SOURCE: "local",
    },
  };
}

export function createDevelopmentSyncEnvironment(
  options: {
    homeDirectory?: string;
    environment?: NodeJS.ProcessEnv;
    platform?: "win32" | "darwin" | "linux";
  } = {},
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`Cinba Dev is not available on ${platform}`);
  }
  const environment = options.environment ?? process.env;
  const paths = resolveProductPaths({
    platform,
    homeDirectory: options.homeDirectory ?? homedir(),
    identity: "development",
    environment,
  });
  return {
    ...environment,
    CINBA_SYNC_HOST: "127.0.0.1",
    CINBA_SYNC_PORT: "4519",
    CINBA_SYNC_PUBLIC_ORIGIN: "http://127.0.0.1:4519",
    CINBA_SYNC_STATE_DIR: paths.syncDataDirectory,
  };
}
