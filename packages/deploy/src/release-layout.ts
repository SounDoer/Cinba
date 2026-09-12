import { posix } from "node:path";

function normalizeRevision(value: string): string {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error("Release name is not a full Git revision");
  }
  return value.toLowerCase();
}

function normalizeRoot(releasesRoot: string): string {
  if (!posix.isAbsolute(releasesRoot)) {
    throw new Error("Releases root must be an absolute POSIX path");
  }
  const root = posix.resolve(releasesRoot);
  if (root === "/") {
    throw new Error("Filesystem root cannot be used as the releases root");
  }
  return root;
}

export function releasePath(releasesRoot: string, revision: string): string {
  return posix.join(normalizeRoot(releasesRoot), normalizeRevision(revision));
}

/** Resolve a current symlink target and prove that it names one direct child release. */
export function currentReleaseRevision(options: {
  releasesRoot: string;
  currentLink: string;
  linkTarget: string;
}): string {
  const root = normalizeRoot(options.releasesRoot);
  if (!posix.isAbsolute(options.currentLink)) {
    throw new Error("Current link must be an absolute POSIX path");
  }
  const target = posix.resolve(posix.dirname(options.currentLink), options.linkTarget);
  if (posix.dirname(target) !== root) {
    throw new Error("Current link target is outside the releases root");
  }
  return normalizeRevision(posix.basename(target));
}

/**
 * Return only validated direct children that may be removed. Unexpected names
 * are ignored for a person to inspect; they are never treated as releases.
 */
export function releasesToRemove(options: {
  releasesRoot: string;
  entries: Iterable<{ name: string; isDirectory: boolean }>;
  protectedRevisions: Iterable<string>;
}): string[] {
  const root = normalizeRoot(options.releasesRoot);
  const protectedRevisions = new Set(
    [...options.protectedRevisions].map((revision) => normalizeRevision(revision)),
  );
  const removable: string[] = [];

  for (const entry of options.entries) {
    if (!entry.isDirectory || !/^[0-9a-f]{40}$/i.test(entry.name)) {
      continue;
    }
    const revision = entry.name.toLowerCase();
    if (!protectedRevisions.has(revision)) {
      removable.push(posix.join(root, revision));
    }
  }
  return removable.toSorted();
}
