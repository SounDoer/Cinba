import { lstat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { posix } from "node:path";
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
  setManagedServiceMode,
} from "@cinba/installer";

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
      }),
    availability: { productInstalled: true, componentCreated },
    ...(options.verifyHealth ? { verifyHealth: options.verifyHealth } : {}),
  };
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
  return await setManagedServiceMode(await serviceManagerOptions(component, options), mode);
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
  return lines.join("\n");
}
