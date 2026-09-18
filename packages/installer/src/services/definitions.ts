import { posix, win32 } from "node:path";
import type { ProductPaths } from "../paths.ts";
import type { ServiceComponent, ServiceMode } from "./service-state.ts";

export type ServicePlatform = "win32" | "darwin" | "linux";

export type ManagedServiceDefinition = {
  component: ServiceComponent;
  registrationId: string;
  displayName: string;
  launcherPath: string;
  arguments: readonly string[];
  logPath: string;
  healthUrl: string;
  stopTimeoutMs: number;
  allowedModes: readonly ServiceMode[];
};

function registrationId(platform: ServicePlatform, component: ServiceComponent): string {
  if (platform === "win32") {
    return component === "core" ? "\\Cinba\\Core" : "\\Cinba\\Sync";
  }
  if (platform === "darwin") {
    return component === "core" ? "com.soundoer.cinba.core" : "com.soundoer.cinba.sync";
  }
  return component === "core" ? "cinba-core.service" : "cinba-sync.service";
}

export function createManagedServiceDefinitions(
  paths: ProductPaths,
  platform: ServicePlatform,
): Readonly<Record<ServiceComponent, ManagedServiceDefinition>> {
  const pathImplementation = platform === "win32" ? win32 : posix;
  if (
    !pathImplementation.isAbsolute(paths.launcherPath) ||
    !pathImplementation.isAbsolute(paths.logDirectory)
  ) {
    throw new Error("managed services require absolute launcher and log paths");
  }
  const logPath = (name: string) => pathImplementation.join(paths.logDirectory, name);
  return {
    core: {
      component: "core",
      registrationId: registrationId(platform, "core"),
      displayName: "Cinba Core",
      launcherPath: paths.launcherPath,
      arguments: ["service", "core"],
      logPath: logPath("core.log"),
      healthUrl: "http://127.0.0.1:4517/healthz",
      stopTimeoutMs: 16 * 60 * 1_000,
      allowedModes: ["on-demand", "background"],
    },
    sync: {
      component: "sync",
      registrationId: registrationId(platform, "sync"),
      displayName: "Cinba Sync",
      launcherPath: paths.launcherPath,
      arguments: ["service", "sync"],
      logPath: logPath("sync.log"),
      healthUrl: "http://127.0.0.1:4518/health",
      stopTimeoutMs: 30_000,
      allowedModes: ["disabled", "on-demand", "background"],
    },
  };
}
