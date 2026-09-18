import { posix, win32 } from "node:path";

export type ProductIdentity = "release" | "development";

export type ProductIdentityDefinition = {
  displayName: "Cinba" | "Cinba Dev";
  applicationId: "com.soundoer.cinba" | "com.soundoer.cinba.dev";
  directoryName: "Cinba" | "Cinba Dev";
  slug: "cinba" | "cinba-dev";
  launcherName: "cinba" | "cinba-dev";
};

export const PRODUCT_IDENTITIES: Readonly<Record<ProductIdentity, ProductIdentityDefinition>> = {
  release: {
    displayName: "Cinba",
    applicationId: "com.soundoer.cinba",
    directoryName: "Cinba",
    slug: "cinba",
    launcherName: "cinba",
  },
  development: {
    displayName: "Cinba Dev",
    applicationId: "com.soundoer.cinba.dev",
    directoryName: "Cinba Dev",
    slug: "cinba-dev",
    launcherName: "cinba-dev",
  },
};

export type ProductPaths = {
  identity: ProductIdentity;
  applicationId: string;
  programDirectory: string;
  releasesDirectory: string;
  managerDirectory: string;
  currentPointerDirectory: string;
  dataDirectory: string;
  syncDataDirectory: string;
  configurationDirectory: string;
  stateDirectory: string;
  transactionDirectory: string;
  cacheDirectory: string;
  logDirectory: string;
  launcherDirectory: string;
  launcherPath: string;
  desktopApplicationPath: string | null;
};

export type ResolveProductPathsOptions = {
  platform: "win32" | "darwin" | "linux";
  homeDirectory: string;
  identity?: ProductIdentity;
  environment?: Readonly<Record<string, string | undefined>>;
};

function environmentPath(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: string,
  platform: "win32" | "linux",
): string {
  const configured = environment[name]?.trim();
  if (!configured) {
    return fallback;
  }
  const absolute =
    platform === "win32" ? win32.isAbsolute(configured) : posix.isAbsolute(configured);
  if (!absolute) {
    throw new Error(`${name} must be an absolute path`);
  }
  return configured;
}

function windowsPaths(
  homeDirectory: string,
  identity: ProductIdentity,
  environment: Readonly<Record<string, string | undefined>>,
): ProductPaths {
  if (!win32.isAbsolute(homeDirectory)) {
    throw new Error("homeDirectory must be an absolute Windows path");
  }
  const definition = PRODUCT_IDENTITIES[identity];
  const localAppData = environmentPath(
    environment,
    "LOCALAPPDATA",
    win32.join(homeDirectory, "AppData", "Local"),
    "win32",
  );
  const productRoot = win32.join(localAppData, definition.directoryName);
  const programDirectory = win32.join(localAppData, "Programs", definition.directoryName);
  const dataDirectory = win32.join(productRoot, "Data");
  const stateDirectory = win32.join(productRoot, "State");
  const launcherDirectory = win32.join(programDirectory, "bin");
  return {
    identity,
    applicationId: definition.applicationId,
    programDirectory,
    releasesDirectory: win32.join(programDirectory, "releases"),
    managerDirectory: win32.join(programDirectory, "installer"),
    currentPointerDirectory: programDirectory,
    dataDirectory,
    syncDataDirectory: win32.join(dataDirectory, "Sync"),
    configurationDirectory: win32.join(dataDirectory, "Config"),
    stateDirectory,
    transactionDirectory: win32.join(stateDirectory, "install"),
    cacheDirectory: win32.join(productRoot, "Cache"),
    logDirectory: win32.join(productRoot, "Logs"),
    launcherDirectory,
    launcherPath: win32.join(launcherDirectory, `${definition.launcherName}.exe`),
    desktopApplicationPath: win32.join(
      programDirectory,
      "desktop",
      `${definition.displayName}.exe`,
    ),
  };
}

function macosPaths(homeDirectory: string, identity: ProductIdentity): ProductPaths {
  if (!posix.isAbsolute(homeDirectory)) {
    throw new Error("homeDirectory must be an absolute macOS path");
  }
  const definition = PRODUCT_IDENTITIES[identity];
  const supportRoot = posix.join(
    homeDirectory,
    "Library",
    "Application Support",
    definition.applicationId,
  );
  const dataDirectory = posix.join(supportRoot, "Data");
  const stateDirectory = posix.join(supportRoot, "State");
  const launcherDirectory = posix.join(homeDirectory, ".local", "bin");
  return {
    identity,
    applicationId: definition.applicationId,
    programDirectory: posix.join(homeDirectory, "Applications", `${definition.displayName}.app`),
    releasesDirectory: posix.join(supportRoot, "Releases"),
    managerDirectory: posix.join(supportRoot, "Installer"),
    currentPointerDirectory: posix.join(supportRoot, "Installer"),
    dataDirectory,
    syncDataDirectory: posix.join(dataDirectory, "Sync"),
    configurationDirectory: posix.join(dataDirectory, "Config"),
    stateDirectory,
    transactionDirectory: posix.join(stateDirectory, "Install"),
    cacheDirectory: posix.join(homeDirectory, "Library", "Caches", definition.applicationId),
    logDirectory: posix.join(homeDirectory, "Library", "Logs", definition.applicationId),
    launcherDirectory,
    launcherPath: posix.join(launcherDirectory, definition.launcherName),
    desktopApplicationPath: posix.join(
      homeDirectory,
      "Applications",
      `${definition.displayName}.app`,
    ),
  };
}

function linuxPaths(
  homeDirectory: string,
  identity: ProductIdentity,
  environment: Readonly<Record<string, string | undefined>>,
): ProductPaths {
  if (!posix.isAbsolute(homeDirectory)) {
    throw new Error("homeDirectory must be an absolute Linux path");
  }
  const definition = PRODUCT_IDENTITIES[identity];
  const localRoot = posix.join(homeDirectory, ".local");
  const dataHome = environmentPath(
    environment,
    "XDG_DATA_HOME",
    posix.join(localRoot, "share"),
    "linux",
  );
  const stateHome = environmentPath(
    environment,
    "XDG_STATE_HOME",
    posix.join(localRoot, "state"),
    "linux",
  );
  const cacheHome = environmentPath(
    environment,
    "XDG_CACHE_HOME",
    posix.join(homeDirectory, ".cache"),
    "linux",
  );
  const configHome = environmentPath(
    environment,
    "XDG_CONFIG_HOME",
    posix.join(homeDirectory, ".config"),
    "linux",
  );
  const programDirectory = posix.join(localRoot, "lib", definition.slug);
  const dataDirectory = posix.join(dataHome, definition.slug, "data");
  const stateDirectory = posix.join(stateHome, definition.slug);
  const launcherDirectory = posix.join(localRoot, "bin");
  return {
    identity,
    applicationId: definition.applicationId,
    programDirectory,
    releasesDirectory: posix.join(programDirectory, "releases"),
    managerDirectory: posix.join(programDirectory, "installer"),
    currentPointerDirectory: programDirectory,
    dataDirectory,
    syncDataDirectory: posix.join(dataDirectory, "Sync"),
    configurationDirectory: posix.join(configHome, definition.slug),
    stateDirectory,
    transactionDirectory: posix.join(stateDirectory, "install"),
    cacheDirectory: posix.join(cacheHome, definition.slug),
    logDirectory: posix.join(stateDirectory, "logs"),
    launcherDirectory,
    launcherPath: posix.join(launcherDirectory, definition.launcherName),
    desktopApplicationPath: null,
  };
}

export function resolveProductPaths(options: ResolveProductPathsOptions): ProductPaths {
  const identity = options.identity ?? "release";
  const environment = options.environment ?? {};
  if (options.platform === "win32") {
    return windowsPaths(options.homeDirectory, identity, environment);
  }
  if (options.platform === "darwin") {
    return macosPaths(options.homeDirectory, identity);
  }
  return linuxPaths(options.homeDirectory, identity, environment);
}
