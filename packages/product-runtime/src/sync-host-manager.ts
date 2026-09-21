import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import type { LocalCoreSyncEnrollmentReceipt } from "@cinba/core-client";
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
  type ManagedSyncHostStatus,
  createManagedSyncControlConfig,
  inspectManagedSyncHost,
  stopManagedSyncControl,
} from "./sync-control.ts";

type SupportedPlatform = "win32" | "darwin" | "linux";

export type ProductSyncHostOptions = Omit<ProductManagedServiceOptions, "componentCreated"> & {
  syncControl?: {
    probeHealth?: (baseUrl: string) => Promise<boolean>;
    processIsAlive?: (pid: number) => boolean;
    requestStatus?: (baseUrl: string, token: string) => Promise<LocalSyncControlStatus | undefined>;
    requestHostStatus?: (
      baseUrl: string,
      token: string,
    ) => Promise<ManagedSyncHostStatus | undefined>;
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
      setupState: ManagedSyncHostStatus["setupState"] | null;
      settingsRevision: number | null;
      syncRevision: number | null;
      connectedCoreCount: number | null;
      pendingEnrollmentCount: number | null;
    };

export type ProductSyncHostCreateRuntime = {
  ensureCore(): Promise<void>;
  startSync(config: { publicOrigin: string }): Promise<void>;
  beginEnrollment(publicOrigin: string): Promise<LocalCoreSyncEnrollmentReceipt>;
  bootstrap(receipt: LocalCoreSyncEnrollmentReceipt): Promise<void>;
  waitCoreOnline(): Promise<void>;
  readSetupCode(): Promise<string | undefined>;
  stopSync(): Promise<void>;
  cancelEnrollment(): Promise<void>;
};

export type ProductSyncHostCreateOptions = ProductSyncHostOptions & {
  createRuntime: ProductSyncHostCreateRuntime;
};

export type ProductSyncHostCreation = {
  status: ProductSyncHostStatus;
  setupCode?: string;
};

export type ProductSyncHostDeleteOptions = ProductSyncHostOptions & {
  deleteRuntime: {
    prepareDisconnect(): Promise<void>;
    stopSync(): Promise<void>;
  };
};

export async function deleteProductSyncHost(
  options: ProductSyncHostDeleteOptions,
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
      return { schemaVersion: 1, state: "not-created" };
    }
    if (storage.state !== "created") {
      throw new Error(`Cinba Sync Host requires repair: ${storage.state}`);
    }
    await options.deleteRuntime.prepareDisconnect();
    await options.deleteRuntime.stopSync();
    await setProductComponentMode("sync", "disabled", {
      ...options,
      componentCreated: true,
      installationLockHeld: true,
    });
    await rm(syncHostConfigPath(paths), { force: true });
    await rm(paths.syncDataDirectory, { recursive: true, force: true });
    return { schemaVersion: 1, state: "not-created" };
  } finally {
    await unlock();
  }
}

export async function createProductSyncHost(
  publicOrigin: string,
  options: ProductSyncHostCreateOptions,
): Promise<ProductSyncHostCreation> {
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
  let syncStarted = false;
  let enrollmentStarted = false;
  try {
    const storage = await inspectSyncHostStorage(paths);
    if (storage.state === "created") {
      return { status: await inspectProductSyncHost(options) };
    }
    if (storage.state !== "not-created") {
      throw new Error(`Cinba Sync Host requires repair: ${storage.state}`);
    }
    await options.createRuntime.ensureCore();
    syncStarted = true;
    await options.createRuntime.startSync(config);
    const receipt = await options.createRuntime.beginEnrollment(config.publicOrigin);
    enrollmentStarted = true;
    await options.createRuntime.bootstrap(receipt);
    await options.createRuntime.waitCoreOnline();
    enrollmentStarted = false;
    const setupCode = await options.createRuntime.readSetupCode();
    await options.createRuntime.stopSync();
    syncStarted = false;
    await writeSyncHostConfig(syncHostConfigPath(paths), config);
    await setProductComponentMode("sync", "on-demand", {
      ...options,
      componentCreated: true,
      installationLockHeld: true,
    });
    return {
      status: await inspectProductSyncHost(options),
      ...(setupCode ? { setupCode } : {}),
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (enrollmentStarted) {
      try {
        await options.createRuntime.cancelEnrollment();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (syncStarted) {
      try {
        await options.createRuntime.stopSync();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await rm(syncHostConfigPath(paths), { force: true });
      await rm(paths.syncDataDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Cinba Sync Host creation failed and its uncommitted state could not be fully removed",
        { cause: error },
      );
    }
    throw error;
  } finally {
    await unlock();
  }
}

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
    let hostStatus: ManagedSyncHostStatus | undefined;
    if (service.running && service.healthy === true) {
      try {
        hostStatus = await inspectManagedSyncHost({
          config: createManagedSyncControlConfig(paths.stateDirectory),
          ...options.syncControl,
        });
      } catch {
        // Lifecycle status remains useful while the protected control plane is unavailable.
      }
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
      setupState: hostStatus?.setupState ?? null,
      settingsRevision: hostStatus?.settingsRevision ?? null,
      syncRevision: hostStatus?.syncRevision ?? null,
      connectedCoreCount: hostStatus?.connectedCoreCount ?? null,
      pendingEnrollmentCount: hostStatus?.pendingEnrollmentCount ?? null,
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
  if (status.setupState !== null) {
    lines.push(`  Setup: ${status.setupState === "setup-required" ? "required" : "ready"}`);
  }
  if (status.connectedCoreCount !== null) {
    lines.push(`  Connected Cores: ${status.connectedCoreCount}`);
  }
  if (status.pendingEnrollmentCount !== null) {
    lines.push(`  Pending enrollments: ${status.pendingEnrollmentCount}`);
  }
  if (status.settingsRevision !== null) {
    lines.push(`  Settings revision: ${status.settingsRevision}`);
  }
  if (status.syncRevision !== null) {
    lines.push(`  Sync revision: ${status.syncRevision}`);
  }
  return lines.join("\n");
}
