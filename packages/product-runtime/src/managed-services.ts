import { lstat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { posix } from "node:path";
import type { CoreHealth } from "@cinba/core-client";
import {
  type LocalCoreConfig,
  acquireStartLock,
  inspectLocalCore,
  stopLocalCore,
} from "@cinba/core-manager";
import {
  type ManagedServiceDefinition,
  type ManagedServiceStatus,
  type PlatformServiceAdapter,
  type ServiceComponent,
  type ServiceMode,
  createLinuxSystemdUserAdapter,
  createMacosLaunchAgentAdapter,
  createManagedServiceDefinitions,
  createWindowsScheduledTaskAdapter,
  inspectManagedService,
  resolveProductPaths,
  restartManagedBackgroundService,
  setManagedServiceMode,
} from "@cinba/installer";
import {
  type CoreServiceStatusRequest,
  createCoreServiceControlConfig,
  verifyCoreServiceIdentity,
} from "./core-service-control.ts";

type SupportedPlatform = "win32" | "darwin" | "linux";

export type ProductManagedServiceOptions = {
  platform?: SupportedPlatform;
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  userName?: string;
  userId?: number;
  adapter?: PlatformServiceAdapter;
  componentCreated?: boolean;
  verifyHealth?: (definition: ManagedServiceDefinition) => Promise<void>;
  /** The caller already holds the installation lock; see ServiceManagerOptions. */
  installationLockHeld?: boolean;
  /** Linux: asks whether Cinba may enable linger when the user explicitly chose Background. */
  authorizeLinger?: (userName: string) => Promise<boolean>;
  /** The on-demand Core that Background must take over from. */
  localCore?: {
    config: LocalCoreConfig;
    probe?: (baseUrl: string) => Promise<CoreHealth | undefined>;
    requestStatus?: CoreServiceStatusRequest;
    requestStop?: (baseUrl: string, token: string) => Promise<boolean>;
  };
};

function supportedPlatform(platform: NodeJS.Platform): SupportedPlatform {
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`Cinba Background is not available on ${platform}`);
  }
  return platform;
}

function windowsUserName(environment: NodeJS.ProcessEnv, configured?: string): string {
  const name = configured?.trim() || userInfo().username;
  if (name.includes("\\")) {
    return name;
  }
  const domain = environment.USERDOMAIN?.trim();
  return domain ? `${domain}\\${name}` : name;
}

function createPlatformAdapter(options: {
  platform: SupportedPlatform;
  homeDirectory: string;
  environment: NodeJS.ProcessEnv;
  userName?: string;
  userId?: number;
  authorizeLinger?: (userName: string) => Promise<boolean>;
}): PlatformServiceAdapter {
  if (options.platform === "win32") {
    return createWindowsScheduledTaskAdapter({
      userName: windowsUserName(options.environment, options.userName),
    });
  }
  if (options.platform === "darwin") {
    const userId = options.userId ?? process.getuid?.();
    if (userId === undefined) {
      throw new Error("macOS Background could not resolve the current user id");
    }
    return createMacosLaunchAgentAdapter({
      userId,
      launchAgentsDirectory: posix.join(options.homeDirectory, "Library", "LaunchAgents"),
    });
  }
  const configHome =
    options.environment.XDG_CONFIG_HOME?.trim() || posix.join(options.homeDirectory, ".config");
  if (!posix.isAbsolute(configHome)) {
    throw new Error("XDG_CONFIG_HOME must be an absolute path");
  }
  return createLinuxSystemdUserAdapter({
    userName: options.userName?.trim() || userInfo().username,
    userUnitDirectory: posix.join(configHome, "systemd", "user"),
    ...(options.authorizeLinger ? { authorizeLinger: options.authorizeLinger } : {}),
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function serviceManagerOptions(
  component: ServiceComponent,
  options: ProductManagedServiceOptions,
) {
  const platform = supportedPlatform(options.platform ?? process.platform);
  const homeDirectory = options.homeDirectory ?? homedir();
  const environment = options.environment ?? process.env;
  const paths = resolveProductPaths({ platform, homeDirectory, environment });
  const definitions = createManagedServiceDefinitions(paths, platform);
  // Core health must come from the Background service itself, not whichever Core holds the port.
  const verifyHealth =
    options.verifyHealth ??
    (component === "core"
      ? async () =>
          await verifyCoreServiceIdentity(
            createCoreServiceControlConfig(paths.stateDirectory),
            options.localCore?.requestStatus,
          )
      : undefined);
  const componentCreated =
    options.componentCreated ??
    (component === "core" ? true : await pathExists(paths.syncDataDirectory));
  return {
    layout: {
      programDirectory: paths.programDirectory,
      releasesDirectory: paths.releasesDirectory,
      transactionDirectory: paths.transactionDirectory,
    },
    serviceStateDirectory: paths.stateDirectory,
    definition: definitions[component],
    adapter:
      options.adapter ??
      createPlatformAdapter({
        platform,
        homeDirectory,
        environment,
        ...(options.userName ? { userName: options.userName } : {}),
        ...(options.userId === undefined ? {} : { userId: options.userId }),
        ...(options.authorizeLinger ? { authorizeLinger: options.authorizeLinger } : {}),
      }),
    availability: { productInstalled: true, componentCreated },
    ...(verifyHealth ? { verifyHealth } : {}),
    ...(options.installationLockHeld ? { installationLockHeld: true } : {}),
  };
}

/** Stop an idle on-demand Core so the Background service can bind the shared Core address. */
async function handOffOnDemandCore(
  localCore: NonNullable<ProductManagedServiceOptions["localCore"]>,
  isBackgroundService: () => Promise<boolean>,
): Promise<void> {
  const { config, probe, requestStatus, requestStop } = localCore;
  const current = await inspectLocalCore(config, probe, requestStatus);
  if (!current.running) {
    return;
  }
  if (!current.managed) {
    if (await isBackgroundService()) {
      return;
    }
    throw new Error(
      "another Cinba Core is using 127.0.0.1:4517 and cannot be stopped by Cinba; stop it before switching to background",
    );
  }
  if (current.state === "draining" || current.safeToStop === false) {
    throw new Error(
      "the on-demand Cinba Core has active work; retry 'cinba core mode background' after it finishes",
    );
  }
  const stopped = await stopLocalCore({
    config,
    ...(probe ? { probe } : {}),
    ...(requestStatus ? { requestStatus } : {}),
    ...(requestStop ? { requestStop } : {}),
  });
  if (stopped.running) {
    throw new Error(
      "the on-demand Cinba Core is still finishing its work; retry 'cinba core mode background' after it stops",
    );
  }
}

export async function inspectProductComponentMode(
  component: ServiceComponent,
  options: ProductManagedServiceOptions = {},
): Promise<ManagedServiceStatus> {
  return await inspectManagedService(await serviceManagerOptions(component, options));
}

export async function setProductComponentMode(
  component: ServiceComponent,
  mode: ServiceMode,
  options: ProductManagedServiceOptions = {},
): Promise<ManagedServiceStatus> {
  const managerOptions = await serviceManagerOptions(component, options);
  if (component !== "core" || mode !== "background" || !options.localCore) {
    return await setManagedServiceMode(managerOptions, mode);
  }
  // Holding the start lock keeps Desktop and the TUI from spawning a new on-demand Core
  // between the handoff and the service binding the port.
  const release = await acquireStartLock(options.localCore.config.startLockPath);
  try {
    // Refuse before the handoff so an unusable Background never stops the running on-demand Core.
    await managerOptions.adapter.prepareBackground?.(managerOptions.definition);
    await handOffOnDemandCore(options.localCore, async () => {
      try {
        await managerOptions.verifyHealth?.(managerOptions.definition);
        return true;
      } catch {
        return false;
      }
    });
    return await setManagedServiceMode(managerOptions, mode);
  } finally {
    release();
  }
}

export async function restartProductBackgroundService(
  component: ServiceComponent,
  options: ProductManagedServiceOptions = {},
): Promise<ManagedServiceStatus> {
  return await restartManagedBackgroundService(await serviceManagerOptions(component, options));
}

export function formatProductComponentMode(status: ManagedServiceStatus): string {
  const name = status.component === "core" ? "Cinba Core" : "Cinba Sync";
  if (status.state === "not-installed") {
    return `${name}: not installed`;
  }
  if (status.state === "not-created") {
    return `${name}: not created`;
  }
  const lines = [`${name} mode: ${status.state}`];
  if (status.phase !== "stable") {
    lines.push(`  Operation: ${status.phase}`);
  }
  if (status.state === "background" || status.registered || status.running) {
    let serviceState = "missing";
    if (status.running) {
      serviceState = "running";
    } else if (status.registered) {
      serviceState = "stopped";
    }
    lines.push(`  Service: ${serviceState}`);
  }
  if (status.healthy !== null) {
    lines.push(`  Health: ${status.healthy ? "healthy" : "unhealthy"}`);
  }
  if (status.failure) {
    lines.push(`  Failure: ${status.failure}`);
  }
  if (status.backgroundUnavailable) {
    lines.push(`  Background: unavailable (${status.backgroundUnavailable})`);
  }
  return lines.join("\n");
}
