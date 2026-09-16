import { existsSync, unlinkSync } from "node:fs";
import { type SyncSnapshot, parseSyncSnapshot } from "@cinba/sync-contract";
import { type StoredJsonError, loadStoredJson, writeAtomicJson } from "../atomic-json-store.ts";

export type CachedSyncSnapshot = {
  snapshot: SyncSnapshot;
  etag?: string;
  savedAt: string;
};

export type SnapshotCache = {
  get(): CachedSyncSnapshot | undefined;
  commit(snapshot: SyncSnapshot, etag?: string): boolean;
  clear(): void;
  problem(): StoredJsonError | undefined;
};

export class SnapshotCacheValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SnapshotCacheValidationError";
  }
}

type SnapshotWriter = (path: string, document: unknown, validate: (value: unknown) => void) => void;

function parseCache(value: unknown): CachedSyncSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a Snapshot cache object");
  }
  const document = value as Record<string, unknown>;
  if (
    document.version !== 1 ||
    typeof document.savedAt !== "string" ||
    (document.etag !== undefined && typeof document.etag !== "string") ||
    Object.keys(document).some(
      (key) => key !== "version" && key !== "snapshot" && key !== "etag" && key !== "savedAt",
    )
  ) {
    throw new Error("unsupported Snapshot cache document");
  }
  return {
    snapshot: parseSyncSnapshot(document.snapshot),
    ...(document.etag === undefined ? {} : { etag: document.etag }),
    savedAt: document.savedAt,
  };
}

export function createSnapshotCache(
  path: string,
  options: { now?: () => Date; write?: SnapshotWriter } = {},
): SnapshotCache {
  const loaded = loadStoredJson(path, parseCache);
  let cached = loaded.status === "valid" ? loaded.value : undefined;
  const loadProblem = loaded.status === "invalid" ? loaded.error : undefined;
  const now = options.now ?? (() => new Date());
  const write = options.write ?? writeAtomicJson;

  return {
    get: () => (cached ? structuredClone(cached) : undefined),
    commit: (snapshot, etag) => {
      if (loadProblem) {
        throw loadProblem;
      }
      let validated: SyncSnapshot;
      try {
        validated = parseSyncSnapshot(snapshot);
      } catch (cause) {
        throw new SnapshotCacheValidationError("Sync Snapshot is invalid", { cause });
      }
      if (cached && validated.syncRevision < cached.snapshot.syncRevision) {
        throw new SnapshotCacheValidationError("Sync Snapshot revision moved backwards");
      }
      if (cached?.snapshot.syncRevision === validated.syncRevision) {
        return false;
      }
      const next: CachedSyncSnapshot = {
        snapshot: validated,
        ...(etag ? { etag } : {}),
        savedAt: now().toISOString(),
      };
      write(path, { version: 1, ...next }, parseCache);
      cached = next;
      return true;
    },
    clear: () => {
      if (loadProblem) {
        throw loadProblem;
      }
      if (existsSync(path)) {
        unlinkSync(path);
      }
      cached = undefined;
    },
    problem: () => loadProblem,
  };
}
