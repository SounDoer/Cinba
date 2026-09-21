import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { LocalCoreConfig } from "@cinba/core-manager";
import { resolveProductPaths } from "@cinba/installer";
import { createCoreServiceControlConfig } from "./core-service-control.ts";
import { resolveProductPayloadLayout } from "./layout.ts";
import { inspectProductComponentMode } from "./managed-services.ts";
import {
  createManagedSyncControl,
  createManagedSyncControlConfig,
  removeManagedSyncControl,
} from "./sync-control.ts";
import { type SyncHostConfig, createSyncHostConfig } from "./sync-host-config.ts";

export type ProductServiceComponent = "core" | "sync";
export type ProductProtocolIdentity = {
  version: string;
  revision: string;
  protocolVersion: number;
};

export type ProductServiceProcess = {
  component: ProductServiceComponent;
  entry: string;
  workingDirectory: string;
  environment: NodeJS.ProcessEnv;
  controlStateDirectory?: string;
};

export function createProductServiceProcess(
  payloadRoot: string,
  release: ProductProtocolIdentity,
  component: ProductServiceComponent,
  options: {
    homeDirectory?: string;
    environment?: NodeJS.ProcessEnv;
    platform?: "win32" | "darwin" | "linux";
    managedService?: boolean;
    syncHostConfig?: SyncHostConfig;
  } = {},
): ProductServiceProcess {
  const environment = { ...(options.environment ?? process.env) };
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`Cinba is not available on ${platform}`);
  }
  const payload = resolveProductPayloadLayout(payloadRoot, platform);
  const productJoin = platform === "win32" ? win32.join : posix.join;
  const paths = resolveProductPaths({
    platform,
    homeDirectory: options.homeDirectory ?? homedir(),
    environment,
  });
  if (component === "core") {
    delete environment.CINBA_LOCAL_CONTROL_TOKEN;
    return {
      component,
      entry: payload.coreEntry,
      workingDirectory: payload.root,
      environment: {
        ...environment,
        ELECTRON_RUN_AS_NODE: "1",
        CINBA_CORE_LIFETIME: "persistent",
        CINBA_PRODUCT_VERSION: release.version,
        CINBA_PROTOCOL_VERSION: String(release.protocolVersion),
        CINBA_REVISION: release.revision,
        CINBA_PORT: "4517",
        CINBA_STATE_DIR: productJoin(paths.dataDirectory, "Core"),
        PI_CODING_AGENT_DIR: productJoin(paths.dataDirectory, "Pi"),
        CINBA_EXTENSION_ROOT: payload.extensionRoot,
        CINBA_WEB_ROOT: payload.webRoot,
      },
      ...(options.managedService ? { controlStateDirectory: paths.stateDirectory } : {}),
    };
  }
  delete environment.CINBA_LOCAL_SYNC_CONTROL_TOKEN;
  const syncHostConfig = options.syncHostConfig
    ? createSyncHostConfig(options.syncHostConfig.publicOrigin)
    : createSyncHostConfig();
  return {
    component,
    entry: payload.syncEntry,
    workingDirectory: payload.root,
    environment: {
      ...environment,
      ELECTRON_RUN_AS_NODE: "1",
      CINBA_SYNC_HOST: "127.0.0.1",
      CINBA_SYNC_PORT: "4518",
      CINBA_SYNC_PUBLIC_ORIGIN: syncHostConfig.publicOrigin,
      CINBA_SYNC_STATE_DIR: paths.syncDataDirectory,
      CINBA_SYNC_WEB_ROOT: payload.syncWebRoot,
    },
    ...(options.managedService ? { controlStateDirectory: paths.stateDirectory } : {}),
  };
}

export function createProductCoreConfig(
  payloadRoot: string,
  options: {
    homeDirectory?: string;
    environment?: NodeJS.ProcessEnv;
    platform?: "win32" | "darwin" | "linux";
    release?: ProductProtocolIdentity;
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
  const productJoin = platform === "win32" ? win32.join : posix.join;
  return {
    baseUrl: "http://127.0.0.1:4517/",
    repositoryRoot: payload.root,
    serverEntry: payload.coreEntry,
    stateDirectory: productJoin(paths.dataDirectory, "Core"),
    piAgentDirectory: productJoin(paths.dataDirectory, "Pi"),
    startLockPath: productJoin(paths.stateDirectory, "core-start.lock"),
    runtimePath: productJoin(paths.stateDirectory, "core-runtime.json"),
    controlPath: productJoin(paths.stateDirectory, "core-control.json"),
    logPath: productJoin(paths.logDirectory, "core.log"),
    environment: {
      CINBA_EXTENSION_ROOT: payload.extensionRoot,
      CINBA_WEB_ROOT: payload.webRoot,
      ...(options.release
        ? {
            CINBA_PRODUCT_VERSION: options.release.version,
            CINBA_PROTOCOL_VERSION: String(options.release.protocolVersion),
          }
        : {}),
    },
  };
}

function waitForServiceExit(child: ChildProcess): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const forward = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    for (const signal of signals) {
      process.on(signal, forward);
    }
    const cleanup = () => {
      for (const signal of signals) {
        process.off(signal, forward);
      }
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (code !== null) {
        resolvePromise(code);
      } else if (signal === "SIGINT" || signal === "SIGTERM") {
        resolvePromise(0);
      } else {
        reject(new Error(`service stopped by ${signal ?? "an unknown signal"}`));
      }
    });
  });
}

export async function runProductService(service: ProductServiceProcess): Promise<void> {
  const serviceControl = service.controlStateDirectory
    ? {
        config:
          service.component === "sync"
            ? createManagedSyncControlConfig(service.controlStateDirectory)
            : createCoreServiceControlConfig(service.controlStateDirectory),
        token: randomUUID(),
      }
    : undefined;
  const tokenVariable =
    service.component === "sync" ? "CINBA_LOCAL_SYNC_CONTROL_TOKEN" : "CINBA_LOCAL_CONTROL_TOKEN";
  const child = spawn(process.execPath, [service.entry], {
    cwd: service.workingDirectory,
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...service.environment,
      ...(serviceControl ? { [tokenVariable]: serviceControl.token } : {}),
    },
  });
  const exit = waitForServiceExit(child);
  if (serviceControl) {
    if (!child.pid) {
      child.kill();
      await exit.catch(() => undefined);
      throw new Error(`Cinba ${service.component} did not report a PID`);
    }
    try {
      await createManagedSyncControl({
        config: serviceControl.config,
        pid: child.pid,
        token: serviceControl.token,
      });
    } catch (error) {
      child.kill();
      await exit.catch(() => undefined);
      throw error;
    }
  }
  let code: number;
  try {
    code = await exit;
  } finally {
    if (serviceControl && child.pid) {
      await removeManagedSyncControl(serviceControl.config, child.pid);
    }
  }
  if (code !== 0) {
    throw new Error(`Cinba ${service.component} exited with code ${code}`);
  }
}

export async function runningCoreControlConfig(
  coreConfig: LocalCoreConfig,
  stateDirectory: string,
) {
  const mode = await inspectProductComponentMode("core");
  return mode.state === "background" && mode.running
    ? createCoreServiceControlConfig(stateDirectory)
    : {
        baseUrl: coreConfig.baseUrl,
        runtimePath: coreConfig.runtimePath,
        controlPath: coreConfig.controlPath,
      };
}
