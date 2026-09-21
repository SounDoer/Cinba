import { homedir } from "node:os";
import { CoreSyncControlClient } from "@cinba/core-client";
import { ensureLocalCore } from "@cinba/core-manager";
import { type ServiceMode, resolveProductPaths } from "@cinba/installer";
import {
  beginManagedCoreSyncEnrollment,
  prepareManagedCoreSyncHostDelete,
} from "./core-service-control.ts";
import {
  type ProductProtocolIdentity,
  createProductCoreConfig,
  createProductServiceProcess,
  runProductService,
  runningCoreControlConfig,
} from "./product-service.ts";
import { readProductRelease } from "./release.ts";
import {
  type ProductSyncHostCreation,
  type ProductSyncHostOptions,
  type ProductSyncHostStatus,
  configureProductSyncHost,
  createProductSyncHost,
  deleteProductSyncHost,
  inspectProductSyncHost,
  setProductSyncHostMode,
} from "./sync-host-manager.ts";
import {
  bootstrapManagedSyncHost,
  createManagedSyncControlConfig,
  inspectManagedSyncControl,
  readManagedSyncSetupCode,
  stopManagedSyncControl,
} from "./sync-control.ts";
import { createSyncHostConfig } from "./sync-host-config.ts";

export type InstalledSyncHostManager = {
  inspect(): Promise<ProductSyncHostStatus>;
  create(publicOrigin?: string): Promise<ProductSyncHostCreation>;
  configure(publicOrigin: string): Promise<ProductSyncHostStatus>;
  setMode(mode: ServiceMode): Promise<ProductSyncHostStatus>;
  delete(): Promise<ProductSyncHostStatus>;
};

export function createInstalledSyncHostManager(
  payloadRoot: string,
  release: ProductProtocolIdentity,
  options: ProductSyncHostOptions = {},
): InstalledSyncHostManager {
  return {
    inspect: async () => await inspectProductSyncHost(options),
    create: async (publicOrigin) =>
      await createInstalledSyncHost(
        payloadRoot,
        release,
        publicOrigin ?? createSyncHostConfig().publicOrigin,
        options,
      ),
    configure: async (publicOrigin) => await configureProductSyncHost(publicOrigin, options),
    setMode: async (mode) => await setProductSyncHostMode(mode, options),
    delete: async () => await deleteInstalledSyncHost(payloadRoot, release, options),
  };
}

export function createInstalledSyncHostManagerFromPayload(
  payloadRoot: string,
  options: ProductSyncHostOptions = {},
): InstalledSyncHostManager {
  const release = readProductRelease(payloadRoot);
  return {
    inspect: async () => await inspectProductSyncHost(options),
    create: async (publicOrigin) =>
      await createInstalledSyncHostManager(payloadRoot, await release, options).create(
        publicOrigin,
      ),
    configure: async (publicOrigin) => await configureProductSyncHost(publicOrigin, options),
    setMode: async (mode) => await setProductSyncHostMode(mode, options),
    delete: async () =>
      await createInstalledSyncHostManager(payloadRoot, await release, options).delete(),
  };
}

async function createInstalledSyncHost(
  payloadRoot: string,
  release: ProductProtocolIdentity,
  publicOrigin: string,
  options: ProductSyncHostOptions,
): Promise<ProductSyncHostCreation> {
  const platform = options.platform ?? supportedPlatform();
  const homeDirectory = options.homeDirectory ?? homedir();
  const environment = options.environment ?? process.env;
  const paths = resolveProductPaths({ platform, homeDirectory, environment });
  const coreConfig = createProductCoreConfig(payloadRoot, {
    platform,
    homeDirectory,
    environment,
    release,
  });
  const syncControl = createManagedSyncControlConfig(paths.stateDirectory);
  const coreSync = new CoreSyncControlClient(coreConfig.baseUrl, { timeoutMs: 2_000 });
  let syncRun: Promise<void> | undefined;
  let syncFailure: unknown;
  const delay = (milliseconds: number) =>
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));

  return await createProductSyncHost(publicOrigin, {
    platform,
    homeDirectory,
    environment,
    createRuntime: {
      ensureCore: async () => {
        await ensureLocalCore({ config: coreConfig, expectedRevision: release.revision });
      },
      startSync: async (syncHostConfig) => {
        syncFailure = undefined;
        syncRun = runProductService(
          createProductServiceProcess(payloadRoot, release, "sync", {
            platform,
            homeDirectory,
            environment,
            managedService: true,
            syncHostConfig: { schemaVersion: 1, ...syncHostConfig },
          }),
        ).catch((error: unknown) => {
          syncFailure = error;
        });
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          if (syncFailure) {
            throw syncFailure;
          }
          const status = await inspectManagedSyncControl({ config: syncControl });
          if (status.running && status.managed) {
            return;
          }
          await delay(100);
        }
        throw new Error("Cinba Sync did not become ready for Host creation");
      },
      beginEnrollment: async (serverUrl) =>
        await beginManagedCoreSyncEnrollment(
          await runningCoreControlConfig(coreConfig, paths.stateDirectory, options),
          serverUrl,
        ),
      bootstrap: async (receipt) => {
        await bootstrapManagedSyncHost({
          config: syncControl,
          request: {
            enrollmentId: receipt.enrollmentId,
            enrollmentSecret: receipt.enrollmentSecret,
            settings: receipt.settings,
          },
        });
      },
      waitCoreOnline: async () => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          try {
            if ((await coreSync.status()).state === "online") {
              return;
            }
          } catch {
            // The Core may still be consuming its one-time approval.
          }
          await delay(100);
        }
        throw new Error("Cinba Core did not become online with the new Sync Host");
      },
      readSetupCode: async () => await readManagedSyncSetupCode({ config: syncControl }),
      stopSync: async () => {
        const status = await inspectManagedSyncControl({ config: syncControl });
        if (status.running && status.managed) {
          await stopManagedSyncControl({ config: syncControl });
        }
        await syncRun;
        if (syncFailure) {
          throw syncFailure;
        }
      },
      cancelEnrollment: async () => {
        await coreSync.cancelEnrollment();
      },
    },
    ...options,
  });
}

async function deleteInstalledSyncHost(
  payloadRoot: string,
  release: ProductProtocolIdentity,
  options: ProductSyncHostOptions,
): Promise<ProductSyncHostStatus> {
  const platform = options.platform ?? supportedPlatform();
  const homeDirectory = options.homeDirectory ?? homedir();
  const environment = options.environment ?? process.env;
  const paths = resolveProductPaths({ platform, homeDirectory, environment });
  const coreConfig = createProductCoreConfig(payloadRoot, {
    platform,
    homeDirectory,
    environment,
    release,
  });
  const syncControl = createManagedSyncControlConfig(paths.stateDirectory);
  return await deleteProductSyncHost({
    platform,
    homeDirectory,
    environment,
    deleteRuntime: {
      prepareDisconnect: async () => {
        await ensureLocalCore({ config: coreConfig, expectedRevision: release.revision });
        await prepareManagedCoreSyncHostDelete(
          await runningCoreControlConfig(coreConfig, paths.stateDirectory, options),
        );
      },
      stopSync: async () => {
        const status = await inspectManagedSyncControl({ config: syncControl });
        if (status.running && !status.managed) {
          throw new Error("the running local Sync is not owned by this manager");
        }
        if (status.running) {
          await stopManagedSyncControl({ config: syncControl });
        }
      },
    },
    ...options,
  });
}

function supportedPlatform(): "win32" | "darwin" | "linux" {
  const platform = process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`Cinba is not available on ${platform}`);
  }
  return platform;
}
