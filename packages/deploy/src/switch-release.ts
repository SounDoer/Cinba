import { lstat, readlink, rename, rm, symlink } from "node:fs/promises";
import { posix } from "node:path";
import { currentReleaseRevision, releasePath } from "./release-layout.ts";

type PathKind = "missing" | "directory" | "symlink" | "other";

type SwitchDependencies = {
  pathKind: (path: string) => Promise<PathKind>;
  readLink: (path: string) => Promise<string>;
  createLink: (target: string, path: string) => Promise<void>;
  move: (from: string, to: string) => Promise<void>;
  removeLink: (path: string) => Promise<void>;
};

const DEFAULT_DEPENDENCIES: SwitchDependencies = {
  async pathKind(path) {
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        return "symlink";
      }
      if (stat.isDirectory()) {
        return "directory";
      }
      return "other";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "missing";
      }
      throw error;
    }
  },
  readLink: readlink,
  async createLink(target, path) {
    await symlink(target, path, "dir");
  },
  move: rename,
  async removeLink(path) {
    await rm(path, { force: true });
  },
};

function normalizeExpectedRevision(releasesRoot: string, revision: string): string {
  return posix.basename(releasePath(releasesRoot, revision));
}

async function requireCurrentRevision(
  options: { releasesRoot: string; currentLink: string; expectedRevision: string },
  dependencies: SwitchDependencies,
): Promise<void> {
  if ((await dependencies.pathKind(options.currentLink)) !== "symlink") {
    throw new Error("Current release is not a symbolic link");
  }
  const actualRevision = currentReleaseRevision({
    releasesRoot: options.releasesRoot,
    currentLink: options.currentLink,
    linkTarget: await dependencies.readLink(options.currentLink),
  });
  if (actualRevision !== options.expectedRevision) {
    throw new Error("Current release does not match the expected revision");
  }
}

/** Atomically point current at a prepared release after proving the old pointer is expected. */
export async function switchCurrentRelease(
  options: {
    releasesRoot: string;
    currentLink: string;
    targetRevision: string;
    expectedCurrentRevision?: string;
  },
  overrides: Partial<SwitchDependencies> = {},
): Promise<void> {
  if (!posix.isAbsolute(options.currentLink) || options.currentLink === "/") {
    throw new Error("Current link must be a safe absolute POSIX path");
  }

  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const targetPath = releasePath(options.releasesRoot, options.targetRevision);
  const expectedRevision =
    options.expectedCurrentRevision === undefined
      ? undefined
      : normalizeExpectedRevision(options.releasesRoot, options.expectedCurrentRevision);

  if ((await dependencies.pathKind(targetPath)) !== "directory") {
    throw new Error("Target release is not a prepared directory");
  }

  const currentKind = await dependencies.pathKind(options.currentLink);
  if (currentKind === "missing") {
    if (expectedRevision !== undefined) {
      throw new Error("Current release is missing instead of matching the expected revision");
    }
  } else {
    if (expectedRevision === undefined) {
      throw new Error("Current release does not match the expected revision");
    }
    await requireCurrentRevision(
      {
        releasesRoot: options.releasesRoot,
        currentLink: options.currentLink,
        expectedRevision,
      },
      dependencies,
    );
  }

  const temporaryLink = `${options.currentLink}.next`;
  if ((await dependencies.pathKind(temporaryLink)) !== "missing") {
    throw new Error("Temporary current link already exists");
  }

  const relativeTarget = posix.relative(posix.dirname(options.currentLink), targetPath);
  await dependencies.createLink(relativeTarget, temporaryLink);
  try {
    await dependencies.move(temporaryLink, options.currentLink);
  } catch (error) {
    try {
      await dependencies.removeLink(temporaryLink);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Current release switch failed and its temporary link could not be cleaned",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

/** Remove current after proving that a failed first deployment is the link it names. */
export async function removeCurrentRelease(
  options: { releasesRoot: string; currentLink: string; expectedCurrentRevision: string },
  overrides: Partial<SwitchDependencies> = {},
): Promise<void> {
  if (!posix.isAbsolute(options.currentLink) || options.currentLink === "/") {
    throw new Error("Current link must be a safe absolute POSIX path");
  }
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  await requireCurrentRevision(
    {
      releasesRoot: options.releasesRoot,
      currentLink: options.currentLink,
      expectedRevision: normalizeExpectedRevision(
        options.releasesRoot,
        options.expectedCurrentRevision,
      ),
    },
    dependencies,
  );
  await dependencies.removeLink(options.currentLink);
}
