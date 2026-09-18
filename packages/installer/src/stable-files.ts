import { cp, lstat, mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { PreparedStableFiles } from "./bundle-installation.ts";
import type { ProductPaths } from "./paths.ts";
import type { ProductTarget } from "./platform.ts";
import type { VerifiedReleaseBundle } from "./release-bundle.ts";

export type StableFileInstallMode = "create" | "replace";

type Replacement = {
  destination: string;
  backup: string;
  staged: string;
  hadPrevious: boolean;
};

const WINDOWS_TRANSIENT_FILE_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);

async function renameStable(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== "win32" ||
        !code ||
        !WINDOWS_TRANSIENT_FILE_ERRORS.has(code) ||
        attempt >= 49
      ) {
        throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
}

async function removeStable(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function status(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function requireAbsolute(path: string, description: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`${description} must be an absolute path`);
  }
  return resolve(path);
}

async function prepareReplacement(
  sourcePath: string,
  destinationPath: string,
  mode: StableFileInstallMode,
): Promise<Replacement> {
  const source = requireAbsolute(sourcePath, "stable file source");
  const destination = requireAbsolute(destinationPath, "stable file destination");
  const sourceStatus = await lstat(source);
  if (sourceStatus.isSymbolicLink() || (!sourceStatus.isFile() && !sourceStatus.isDirectory())) {
    throw new Error("stable file source must be a regular file or directory");
  }

  const previousStatus = await status(destination);
  if (previousStatus?.isSymbolicLink()) {
    throw new Error(`stable file destination must not be a symbolic link: ${destination}`);
  }
  if (previousStatus && mode === "create") {
    throw new Error(`stable file destination already exists: ${destination}`);
  }
  if (previousStatus && previousStatus.isDirectory() !== sourceStatus.isDirectory()) {
    throw new Error(`stable file destination has the wrong type: ${destination}`);
  }

  const parent = dirname(destination);
  const name = basename(destination);
  const staged = join(parent, `.${name}.cinba-new`);
  const backup = join(parent, `.${name}.cinba-old`);
  await mkdir(parent, { recursive: true });
  if ((await status(staged)) || (await status(backup))) {
    throw new Error(`unfinished stable file replacement exists beside ${destination}`);
  }

  try {
    await cp(source, staged, {
      recursive: sourceStatus.isDirectory(),
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    if (previousStatus) {
      await renameStable(destination, backup);
    }
    try {
      await renameStable(staged, destination);
    } catch (error) {
      if (previousStatus) {
        await renameStable(backup, destination);
      }
      throw error;
    }
    return { destination, backup, staged, hadPrevious: previousStatus !== undefined };
  } catch (error) {
    await removeStable(staged);
    throw error;
  }
}

async function rollbackReplacement(replacement: Replacement): Promise<void> {
  await removeStable(replacement.staged);
  if (replacement.hadPrevious) {
    if (await status(replacement.backup)) {
      await removeStable(replacement.destination);
      await renameStable(replacement.backup, replacement.destination);
    }
  } else {
    await removeStable(replacement.destination);
  }
}

async function commitReplacement(replacement: Replacement): Promise<void> {
  if (!(await status(replacement.destination))) {
    throw new Error(`cannot commit a missing stable file destination: ${replacement.destination}`);
  }
  await removeStable(replacement.staged);
  await removeStable(replacement.backup);
}

function desktopReplacement(
  bundle: VerifiedReleaseBundle,
  paths: ProductPaths,
): { source: string; destination: string } | undefined {
  if (bundle.metadata.target === "linux-x64-gnu") {
    if (bundle.desktopApplication !== null || paths.desktopApplicationPath !== null) {
      throw new Error("Linux headless installs must not contain a Desktop application");
    }
    return undefined;
  }
  if (!bundle.desktopApplication || !paths.desktopApplicationPath) {
    throw new Error("Desktop bundle and installation paths must include an application");
  }
  if (bundle.metadata.target === "windows-x64") {
    return {
      source: dirname(bundle.desktopApplication),
      destination: dirname(paths.desktopApplicationPath),
    };
  }
  return { source: bundle.desktopApplication, destination: paths.desktopApplicationPath };
}

function stableDestinations(target: ProductTarget, paths: ProductPaths): string[] {
  if (target === "linux-x64-gnu") {
    if (paths.desktopApplicationPath !== null) {
      throw new Error("Linux headless installation paths must not include a Desktop application");
    }
    return [paths.launcherPath];
  }
  if (!paths.desktopApplicationPath) {
    throw new Error("Desktop installation paths must include an application");
  }
  return [
    target === "windows-x64" ? dirname(paths.desktopApplicationPath) : paths.desktopApplicationPath,
    paths.launcherPath,
  ];
}

function replacementForDestination(destinationPath: string, hadPrevious: boolean): Replacement {
  const destination = requireAbsolute(destinationPath, "stable file destination");
  const parent = dirname(destination);
  const name = basename(destination);
  return {
    destination,
    backup: join(parent, `.${name}.cinba-old`),
    staged: join(parent, `.${name}.cinba-new`),
    hadPrevious,
  };
}

export async function prepareStableProductFiles(options: {
  bundle: VerifiedReleaseBundle;
  paths: ProductPaths;
  mode: StableFileInstallMode;
}): Promise<PreparedStableFiles> {
  const replacements: Replacement[] = [];
  try {
    // Copy the launcher before replacing Desktop. A macOS installer can carry its verified bundle
    // inside the very application that this transaction replaces.
    replacements.push(
      await prepareReplacement(options.bundle.launcher, options.paths.launcherPath, options.mode),
    );
    const desktop = desktopReplacement(options.bundle, options.paths);
    if (desktop) {
      replacements.push(
        await prepareReplacement(desktop.source, desktop.destination, options.mode),
      );
    }
  } catch (error) {
    for (const replacement of replacements.toReversed()) {
      await rollbackReplacement(replacement);
    }
    throw error;
  }

  let settled = false;
  return {
    async commit(): Promise<void> {
      if (settled) {
        return;
      }
      for (const replacement of replacements) {
        await commitReplacement(replacement);
      }
      settled = true;
    },
    async rollback(): Promise<void> {
      if (settled) {
        return;
      }
      for (const replacement of replacements.toReversed()) {
        await rollbackReplacement(replacement);
      }
      settled = true;
    },
  };
}

export async function recoverStableProductFiles(options: {
  target: ProductTarget;
  paths: ProductPaths;
  mode: StableFileInstallMode;
  outcome: "commit" | "rollback";
}): Promise<void> {
  const replacements = stableDestinations(options.target, options.paths).map((destination) =>
    replacementForDestination(destination, options.mode === "replace"),
  );
  if (options.outcome === "commit") {
    for (const replacement of replacements) {
      await commitReplacement(replacement);
    }
    return;
  }
  for (const replacement of replacements.toReversed()) {
    await rollbackReplacement(replacement);
  }
}
