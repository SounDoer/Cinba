import { homedir } from "node:os";
import { type ServiceMode, resolveProductPaths } from "@cinba/installer";
import { inspectSyncHostStorage } from "./sync-host-config.ts";
import {
  type ProductManagedServiceOptions,
  inspectProductComponentMode,
} from "./managed-services.ts";

type SupportedPlatform = "win32" | "darwin" | "linux";

export type ProductSyncHostOptions = Omit<ProductManagedServiceOptions, "componentCreated">;

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
