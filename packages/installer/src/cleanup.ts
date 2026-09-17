import type { Dirent } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { dataSnapshotExists, discardDataSnapshot } from "./data-snapshot.ts";
import { acquireInstallationLock } from "./installation-lock.ts";
import {
  type InstallationLayout,
  readCurrentRelease,
  readInstallationTransaction,
} from "./installation-store.ts";

export type InstallationCleanupResult = {
  removed: string[];
  failed: { path: string; error: unknown }[];
};

const RELEASE_DIRECTORY = /^[0-9a-f]{40}$/;
const TRANSIENT_DIRECTORY = /^\.[0-9a-f]{40}\.[0-9a-f-]{36}\.(?:candidate|replaced)$/;

export async function cleanupInstallation(
  layout: InstallationLayout,
): Promise<InstallationCleanupResult> {
  const unlock = await acquireInstallationLock(layout);
  const result: InstallationCleanupResult = { removed: [], failed: [] };
  try {
    const transaction = await readInstallationTransaction(layout);
    if (transaction && !["committed", "rolled-back", "failed"].includes(transaction.phase)) {
      throw new Error(`installation transaction ${transaction.id} is still ${transaction.phase}`);
    }
    const current = await readCurrentRelease(layout);
    let entries: Dirent<string>[];
    try {
      entries = await readdir(resolve(layout.releasesDirectory), {
        withFileTypes: true,
        encoding: "utf8",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      entries = [];
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        (!RELEASE_DIRECTORY.test(entry.name) && !TRANSIENT_DIRECTORY.test(entry.name)) ||
        entry.name === current?.directory
      ) {
        continue;
      }
      const path = join(resolve(layout.releasesDirectory), entry.name);
      try {
        await rm(path, { recursive: true, force: true });
        result.removed.push(path);
      } catch (error) {
        result.failed.push({ path, error });
      }
    }
    if (transaction && (await dataSnapshotExists(layout, transaction.id))) {
      const path = join(resolve(layout.transactionDirectory), "snapshots", transaction.id);
      try {
        await discardDataSnapshot(layout, transaction.id);
        result.removed.push(path);
      } catch (error) {
        result.failed.push({ path, error });
      }
    }
    return result;
  } finally {
    await unlock();
  }
}
