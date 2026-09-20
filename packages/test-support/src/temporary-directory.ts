import { mkdtempSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

/** The part of a `node:test` TestContext this module needs. */
type CleanupRegistry = {
  after(fn: () => void | Promise<void>): void;
};

/**
 * Create a temporary directory and register its removal, so it goes away
 * whether the test passes or fails.
 *
 * Pass the test's context whenever there is one. Omitting it registers a
 * file-level `after` hook instead, which is what a module-scope directory needs.
 */
export function temporaryDirectory(prefix: string, context?: CleanupRegistry): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const registry = context ?? { after };
  registry.after(() => removeTemporaryDirectory(directory));
  return directory;
}

/**
 * Remove a directory tree, tolerating paths that are already gone.
 *
 * Every symbolic link and Windows junction in the tree goes first, before
 * anything deletes what they point at. A junction whose target has been deleted
 * cannot be removed on Windows at all: `lstat`, `rmdir`, `fsutil` and even
 * `CreateFileW` with `FILE_FLAG_OPEN_REPARSE_POINT` report it as missing while
 * `readdir` still lists it, so its parent stays permanently non-empty. A plain
 * recursive remove creates exactly that situation whenever a link and its
 * target sit in the same tree.
 */
export async function removeTemporaryDirectory(path: string): Promise<void> {
  await removeLinksWithin(path);
  await remove(path, { recursive: true });
}

/**
 * Unlink every link in the tree, depth first, without following any of them.
 * Directories are only descended into once they are known not to be links.
 */
async function removeLinksWithin(path: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(longPath(path));
  } catch (error) {
    if (isMissing(error)) {
      return;
    }
    throw error;
  }

  if (entry.isSymbolicLink()) {
    await remove(path);
    return;
  }
  if (!entry.isDirectory()) {
    return;
  }

  let children;
  try {
    children = await readdir(longPath(path), { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return;
    }
    throw error;
  }

  for (const child of children) {
    if (child.isSymbolicLink()) {
      await remove(join(path, child.name));
    } else if (child.isDirectory()) {
      await removeLinksWithin(join(path, child.name));
    }
  }
}

/**
 * `rm` with the retries Windows needs when a virus scanner or the search
 * indexer is still holding a handle, and with an already-removed path treated
 * as success.
 */
async function remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
  try {
    await rm(longPath(path), {
      recursive: options.recursive ?? false,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}

/** Windows refuses paths past 260 characters unless they carry this prefix. */
function longPath(path: string): string {
  if (process.platform !== "win32" || path.startsWith("\\\\?\\") || path.length < 240) {
    return path;
  }
  return `\\\\?\\${path}`;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
