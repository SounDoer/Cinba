import { spawn } from "node:child_process";
import { lstat, mkdir, rm } from "node:fs/promises";
import { posix } from "node:path";
import { releasePath } from "./release-layout.ts";
import type { DeploymentFailure } from "./status.ts";

type RunCommand = (command: string, args: string[], cwd: string) => Promise<void>;

type ReleasePreparationDependencies = {
  pathExists: (path: string) => Promise<boolean>;
  makeDirectory: (path: string) => Promise<void>;
  removeDirectory: (path: string) => Promise<void>;
  runCommand: RunCommand;
};

type PreparationFailure = Extract<DeploymentFailure, "checkout" | "install" | "checks">;

export class ReleasePreparationError extends Error {
  readonly failure: PreparationFailure;

  constructor(failure: PreparationFailure, cause: unknown) {
    super(`Release preparation failed during ${failure}`, { cause });
    this.name = "ReleasePreparationError";
    this.failure = failure;
  }
}

function defaultRunCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args[0] ?? "command"} failed with exit code ${code ?? -1}`));
    });
  });
}

const DEFAULT_DEPENDENCIES: ReleasePreparationDependencies = {
  async pathExists(path) {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  },
  async makeDirectory(path) {
    await mkdir(path, { recursive: true });
  },
  async removeDirectory(path) {
    await rm(path, { recursive: true, force: true });
  },
  runCommand: defaultRunCommand,
};

async function cleanFailedRelease(
  repoPath: string,
  path: string,
  dependencies: ReleasePreparationDependencies,
): Promise<void> {
  let worktreeRemovalFailed = false;
  try {
    await dependencies.runCommand("git", ["worktree", "remove", "--force", path], repoPath);
  } catch {
    worktreeRemovalFailed = true;
  }

  await dependencies.removeDirectory(path);
  if (worktreeRemovalFailed) {
    await dependencies.runCommand("git", ["worktree", "prune", "--expire", "now"], repoPath);
  }
}

/** Remove one validated release worktree that is known not to be current. */
export async function discardRelease(
  options: { repoPath: string; releasesRoot: string; revision: string },
  overrides: Partial<ReleasePreparationDependencies> = {},
): Promise<void> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  await cleanFailedRelease(
    options.repoPath,
    releasePath(options.releasesRoot, options.revision),
    dependencies,
  );
}

async function cleanAfterFailure(
  repoPath: string,
  path: string,
  error: unknown,
  dependencies: ReleasePreparationDependencies,
): Promise<never> {
  try {
    await cleanFailedRelease(repoPath, path, dependencies);
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      "Release preparation failed and its directory could not be cleaned",
      { cause: cleanupError },
    );
  }
  throw error;
}

/** Prepare and validate a target revision without changing the running release. */
export async function prepareRelease(
  options: {
    repoPath: string;
    releasesRoot: string;
    targetRevision: string;
    onChecking?: () => Promise<void>;
  },
  overrides: Partial<ReleasePreparationDependencies> = {},
): Promise<{ path: string; revision: string }> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const path = releasePath(options.releasesRoot, options.targetRevision);
  const revision = posix.basename(path);

  await dependencies.makeDirectory(posix.dirname(path));
  if (await dependencies.pathExists(path)) {
    throw new Error("Target release directory already exists");
  }

  try {
    await dependencies.runCommand(
      "git",
      ["worktree", "add", "--detach", path, revision],
      options.repoPath,
    );
  } catch (error) {
    return await cleanAfterFailure(
      options.repoPath,
      path,
      new ReleasePreparationError("checkout", error),
      dependencies,
    );
  }
  try {
    await dependencies.runCommand("npm", ["ci"], path);
  } catch (error) {
    return await cleanAfterFailure(
      options.repoPath,
      path,
      new ReleasePreparationError("install", error),
      dependencies,
    );
  }
  try {
    await options.onChecking?.();
  } catch (error) {
    return await cleanAfterFailure(options.repoPath, path, error, dependencies);
  }
  try {
    await dependencies.runCommand("npm", ["run", "check"], path);
  } catch (error) {
    return await cleanAfterFailure(
      options.repoPath,
      path,
      new ReleasePreparationError("checks", error),
      dependencies,
    );
  }

  return { path, revision };
}
