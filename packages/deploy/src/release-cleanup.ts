import { readdir } from "node:fs/promises";
import { posix } from "node:path";
import { discardRelease } from "./prepare-release.ts";
import { releasesToRemove } from "./release-layout.ts";
import { readCurrentReleaseRevision } from "./switch-release.ts";

type CleanupDependencies = {
  listEntries: (path: string) => Promise<Array<{ name: string; isDirectory: boolean }>>;
  readCurrent: typeof readCurrentReleaseRevision;
  discard: typeof discardRelease;
};

const DEFAULT_DEPENDENCIES: CleanupDependencies = {
  async listEntries(path) {
    return (await readdir(path, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
  },
  readCurrent: readCurrentReleaseRevision,
  discard: discardRelease,
};

/** Keep exactly the current and previous successful releases, ignoring suspicious entries. */
export async function cleanupReleases(
  options: {
    repoPath: string;
    releasesRoot: string;
    currentLink: string;
    runningRevision: string;
    previousRevision?: string;
  },
  overrides: Partial<CleanupDependencies> = {},
): Promise<string[]> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const actualRevision = await dependencies.readCurrent({
    releasesRoot: options.releasesRoot,
    currentLink: options.currentLink,
  });
  if (actualRevision !== options.runningRevision.toLowerCase()) {
    throw new Error("Current release does not match deployment status; cleanup refused");
  }

  const removable = releasesToRemove({
    releasesRoot: options.releasesRoot,
    entries: await dependencies.listEntries(options.releasesRoot),
    protectedRevisions: [
      options.runningRevision,
      ...(options.previousRevision ? [options.previousRevision] : []),
    ],
  });
  const removed: string[] = [];
  const failures: unknown[] = [];
  for (const path of removable) {
    try {
      await dependencies.discard({
        repoPath: options.repoPath,
        releasesRoot: options.releasesRoot,
        revision: posix.basename(path),
      });
      removed.push(path);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "One or more obsolete releases could not be removed", {
      cause: failures[0],
    });
  }
  return removed;
}
