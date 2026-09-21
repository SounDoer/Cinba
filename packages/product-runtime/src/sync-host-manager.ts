import { homedir } from "node:os";
import { type ServiceMode, acquireInstallationLock, resolveProductPaths } from "@cinba/installer";
import {
  createSyncHostConfig,
  inspectSyncHostStorage,
  syncHostConfigPath,
  writeSyncHostConfig,
} from "./sync-host-config.ts";
import {
  type ProductManagedServiceOptions,
  inspectProductComponentMode,
  restartProductBackgroundService,
  setProductComponentMode,
} from "./managed-services.ts";
import {
  type LocalSyncControlStatus,
  createManagedSyncControlConfig,
  stopManagedSyncControl,
} from "./sync-control.ts";

type SupportedPlatform = "win32" | "darwin" | "linux";

export type ProductSyncHostOptions = Omit<ProductManagedServiceOptions, "componentCreated"> & {
  syncControl?: {
    probeHealth?: (baseUrl: string) => Promise<boolean>;
    processIsAlive?: (pid: number) => boolean;
    requestStatus?: (baseUrl: string, token: string) => Promise<LocalSyncControlStatus | undefined>;
    requestStop?: (
      baseUrl: string,
      token: string,
    ) => Promise<boolean | "accepted" | "busy" | "refused">;
    delay?: (milliseconds: number) => Promise<void>;
    waitTimeoutMs?: number;
    pollIntervalMs?: number;
  };
};

export type ProductSyncHostStatus =
  | { schemaVersion: 1; state: "not-created" }
  | {
      schemaVersion: 1;
      state: "repair-required";
      reason: "orphaned-authority" | "missing-authority" | "invalid-config";
    }
  | {
      schemaVersion: 1;
      state: "created";
      publicOrigin: string;
      availability: "this-device-only" | "remote-https";
      mode: ServiceMode | "unknown";
      running: boolean;
      healthy: boolean | null;
    };

export async function setProductSyncHostMode(
  mode: ServiceMode,
  options: ProductSyncHostOptions = {},
): Promise<ProductSyncHostStatus> {
  const paths = resolveProductPaths({
    platform: supportedPlatform(options.platform ?? process.platform),
    homeDirectory: options.homeDirectory ?? homedir(),
    environment: options.environment ?? process.env,
  });
  const unlock = await acquireInstallationLock({
    programDirectory: paths.programDirectory,
    releasesDirectory: paths.releasesDirectory,
    transactionDirectory: paths.transactionDirectory,
  });
  try {
    const storage = await inspectSyncHostStorage(paths);
    if (storage.state === "not-created") {
      throw new Error("Cinba Sync Host has not been created");
    }
    if (storage.state !== "created") {
      throw new Error(`Cinba Sync Host requires repair: ${storage.state}`);
    }
    await setProductComponentMode("sync", mode, {
      ...options,
      componentCreated: true,
      installationLockHeld: true,
    });
    return await inspectProductSyncHost(options);
  } finally {
    await unlock();
  }
}

export async function configureProductSyncHost(
  publicOrigin: string,
  options: ProductSyncHostOptions = {},
): Promise<ProductSyncHostStatus> {
  const config = createSyncHostConfig(publicOrigin);
  const paths = resolveProductPaths({
    platform: supportedPlatform(options.platform ?? process.platform),
    homeDirectory: options.homeDirectory ?? homedir(),
    environment: options.environment ?? process.env,
  });
  const unlock = await acquireInstallationLock({
    programDirectory: paths.programDirectory,
    releasesDirectory: paths.releasesDirectory,
    transactionDirectory: paths.transactionDirectory,
  });
  try {
    const storage = await inspectSyncHostStorage(paths);
    if (storage.state === "not-created") {
      throw new Error("Cinba Sync Host has not been created");
    }
    if (storage.state !== "created") {
      throw new Error(`Cinba Sync Host requires repair: ${storage.state}`);
    }
    if (storage.config.publicOrigin === config.publicOrigin) {
      return await inspectProductSyncHost(options);
    }
    const service = await inspectProductComponentMode("sync", {
      ...options,
      componentCreated: true,
    });
    if (service.state === "not-created" || service.state === "not-installed") {
      throw new Error("Sync Host service state is inconsistent with committed storage");
    }
    let restartMode: ServiceMode | undefined;
    if (service.running) {
      if (service.state !== "background") {
        throw new Error("Only a Background Cinba Sync Host can be restarted after configuration");
      }
      restartMode = service.state;
      await stopManagedSyncControl({
        config: createManagedSyncControlConfig(paths.stateDirectory),
        ...options.syncControl,
      });
    }
    const configPath = syncHostConfigPath(paths);
    await writeSyncHostConfig(configPath, config);
    if (restartMode) {
      try {
        await restartProductBackgroundService("sync", {
          ...options,
          componentCreated: true,
          installationLockHeld: true,
        });
      } catch (error) {
        await writeSyncHostConfig(configPath, storage.config);
        try {
          await restartProductBackgroundService("sync", {
            ...options,
            componentCreated: true,
            installationLockHeld: true,
          });
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            "Cinba Sync Host configuration failed and its Background service could not be recovered",
            { cause: recoveryError },
          );
        }
        throw error;
      }
    }
    return await inspectProductSyncHost(options);
  } finally {
    await unlock();
  }
}

function supportedPlatform(platform: NodeJS.Platform): SupportedPlatform {
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`Cinba Sync Host is not available on ${platform}`);
  }
  return platform;
}

export async function inspectProductSyncHost(
  options: ProductSyncHostOptions = {},
): Promise<ProductSyncHostStatus> {
  const paths = resolveProductPaths({
    platform: supportedPlatform(options.platform ?? process.platform),
    homeDirectory: options.homeDirectory ?? homedir(),
    environment: options.environment ?? process.env,
  });
  const storage = await inspectSyncHostStorage(paths);
  if (storage.state === "created") {
    const service = await inspectProductComponentMode("sync", {
      ...options,
      componentCreated: true,
    });
    if (service.state === "not-created" || service.state === "not-installed") {
      throw new Error("Sync Host service state is inconsistent with committed storage");
    }
    return {
      schemaVersion: 1,
      state: "created",
      publicOrigin: storage.config.publicOrigin,
      availability:
        storage.config.publicOrigin === "http://127.0.0.1:4518"
          ? "this-device-only"
          : "remote-https",
      mode: service.state,
      running: service.running,
      healthy: service.healthy,
    };
  }
  if (storage.state === "not-created") {
    return { schemaVersion: 1, state: "not-created" };
  }
  return { schemaVersion: 1, state: "repair-required", reason: storage.state };
}

export function formatProductSyncHostStatus(status: ProductSyncHostStatus): string {
  if (status.state === "not-created") {
    return "Cinba Sync Host: not created";
  }
  if (status.state === "repair-required") {
    return `Cinba Sync Host: repair required\n  Reason: ${status.reason.replaceAll("-", " ")}`;
  }
  const availability = status.availability === "remote-https" ? "Remote HTTPS" : "This device only";
  const lines = [
    "Cinba Sync Host: created",
    `  Public origin: ${status.publicOrigin}`,
    `  Availability: ${availability}`,
    `  Mode: ${status.mode}`,
    `  Service: ${status.running ? "running" : "stopped"}`,
  ];
  if (status.healthy !== null) {
    lines.push(`  Health: ${status.healthy ? "healthy" : "unhealthy"}`);
  }
  return lines.join("\n");
}
