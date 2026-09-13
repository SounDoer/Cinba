import { lstat, mkdir, readlink, symlink } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type LauncherPaths = {
  binDirectory: string;
  commandPath: string;
  targetPath: string;
};

type InstallDependencies = {
  pathKind: (path: string) => Promise<"missing" | "symlink" | "other">;
  makeDirectory: (path: string) => Promise<void>;
  readLink: (path: string) => Promise<string>;
  createSymlink: (target: string, path: string) => Promise<void>;
};

export function userLauncherPaths(homeDirectory: string): LauncherPaths {
  if (!posix.isAbsolute(homeDirectory)) {
    throw new Error("Launcher home must be an absolute POSIX path");
  }
  const home = posix.resolve(homeDirectory);
  if (home === "/") {
    throw new Error("Filesystem root cannot be used as the launcher home");
  }
  return {
    binDirectory: posix.join(home, ".local", "bin"),
    commandPath: posix.join(home, ".local", "bin", "cinba"),
    targetPath: posix.join(home, "current", "packages", "deploy", "bin", "cinba"),
  };
}

const DEFAULT_DEPENDENCIES: InstallDependencies = {
  async pathKind(path) {
    try {
      const stat = await lstat(path);
      return stat.isSymbolicLink() ? "symlink" : "other";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "missing";
      }
      throw error;
    }
  },
  async makeDirectory(path) {
    await mkdir(path, { recursive: true, mode: 0o755 });
  },
  readLink: readlink,
  async createSymlink(target, path) {
    await symlink(target, path);
  },
};

/** Install one stable user command that follows the atomically switched current release. */
export async function installUserLauncher(
  homeDirectory: string,
  overrides: Partial<InstallDependencies> = {},
): Promise<"installed" | "already_installed"> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const paths = userLauncherPaths(homeDirectory);
  await dependencies.makeDirectory(paths.binDirectory);

  const kind = await dependencies.pathKind(paths.commandPath);
  if (kind === "other") {
    throw new Error(`${paths.commandPath} exists and is not the managed launcher symlink`);
  }
  if (kind === "symlink") {
    const target = await dependencies.readLink(paths.commandPath);
    if (target !== paths.targetPath) {
      throw new Error(`${paths.commandPath} points to an unexpected target: ${target}`);
    }
    return "already_installed";
  }

  await dependencies.createSymlink(paths.targetPath, paths.commandPath);
  return "installed";
}

async function main(): Promise<void> {
  const home = process.env.CINBA_HOME ?? process.env.HOME;
  if (!home) {
    throw new Error("HOME is required to install the Cinba launcher");
  }
  const result = await installUserLauncher(home);
  console.log(`[launcher] ${result}: ${userLauncherPaths(home).commandPath}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(`[launcher] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
