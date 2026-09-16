import { type SnapshotResult, SyncClientError } from "@cinba/sync-client";
import type { SyncSnapshot } from "@cinba/sync-contract";
import { clearTimeout as nodeClearTimeout, setTimeout as nodeSetTimeout } from "node:timers";
import type { SyncConnectionStore } from "./connection-store.ts";
import { type SnapshotCache, SnapshotCacheValidationError } from "./snapshot-cache.ts";

export type SyncStatusState = "disconnected" | "pending" | "online" | "stale" | "error" | "revoked";

export type CoreSyncStatus = {
  state: SyncStatusState;
  lastSuccessAt?: string;
  syncRevision?: number;
  errorCode?: "offline" | "invalid_snapshot" | "cache_write_failed" | "revoked";
  action?: "retry" | "reconnect";
};

export type SnapshotRemote = {
  snapshot(etag?: string, signal?: AbortSignal): Promise<SnapshotResult>;
};

export type SyncCoordinator = {
  start(): Promise<void>;
  stop(): void;
  syncNow(): Promise<CoreSyncStatus>;
  status(): CoreSyncStatus;
  snapshot(): SyncSnapshot | undefined;
  resetCache(): void;
  disconnect(): void;
};

type Timer = NodeJS.Timeout;

class SnapshotPolicyError extends Error {}

function initialStatus(
  connection: ReturnType<SyncConnectionStore["get"]>,
  cache: SnapshotCache,
): CoreSyncStatus {
  if (!connection) {
    return { state: "disconnected" };
  }
  if (connection.pending) {
    return { state: "pending" };
  }
  const cached = cache.get();
  return cached
    ? {
        state: "stale",
        syncRevision: cached.snapshot.syncRevision,
        errorCode: "offline",
        action: "retry",
      }
    : { state: "error", errorCode: "offline", action: "retry" };
}

export function createSyncCoordinator(options: {
  connection: SyncConnectionStore;
  cache: SnapshotCache;
  remoteFor(serverUrl: string, credential: string): SnapshotRemote;
  onSnapshot?: (snapshot: SyncSnapshot) => void;
  onStatus?: (status: CoreSyncStatus) => void;
  now?: () => Date;
  pollIntervalMs?: number;
  random?: () => number;
  setTimer?: (callback: () => void, delay: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}): SyncCoordinator {
  const now = options.now ?? (() => new Date());
  const pollIntervalMs = options.pollIntervalMs ?? 5 * 60_000;
  const random = options.random ?? Math.random;
  const setTimer: (callback: () => void, delay: number) => Timer =
    options.setTimer ?? ((callback, delay) => nodeSetTimeout(callback, delay) as NodeJS.Timeout);
  const clearTimer: (timer: Timer) => void =
    options.clearTimer ?? ((timer) => nodeClearTimeout(timer));
  let current = options.cache.get()?.snapshot;
  let lastSuccessAt = options.cache.get()?.savedAt;
  let currentStatus = initialStatus(options.connection.get(), options.cache);
  let timer: Timer | undefined;
  let stopped = true;
  let inFlight: Promise<CoreSyncStatus> | undefined;

  function publish(status: CoreSyncStatus): CoreSyncStatus {
    currentStatus = status;
    options.onStatus?.({ ...status });
    return status;
  }

  function schedule(): void {
    if (
      stopped ||
      currentStatus.state === "revoked" ||
      currentStatus.state === "disconnected" ||
      currentStatus.state === "pending"
    ) {
      return;
    }
    const jitter = 0.8 + random() * 0.4;
    const nextTimer = setTimer(
      () => {
        timer = undefined;
        void syncNow().finally(schedule);
      },
      Math.round(pollIntervalMs * jitter),
    );
    timer = nextTimer;
    nextTimer.unref();
  }

  async function synchronize(): Promise<CoreSyncStatus> {
    const connection = options.connection.get();
    if (!connection) {
      return publish({ state: "disconnected" });
    }
    if (!connection.core) {
      return publish({ state: "pending" });
    }
    const cached = options.cache.get();
    try {
      const result = await options
        .remoteFor(connection.serverUrl, connection.core.credential)
        .snapshot(cached?.etag);
      if (result.status === "unchanged") {
        if (!cached) {
          throw new SnapshotPolicyError("Not Modified without a cached Snapshot");
        }
        current = cached.snapshot;
      } else {
        const hasCredentials = result.snapshot.credentials !== undefined;
        if (
          (connection.sources.credentials === "local" && hasCredentials) ||
          (connection.sources.credentials === "sync" && !hasCredentials)
        ) {
          throw new SnapshotPolicyError("Snapshot credentials do not match the configured source");
        }
        const changed = options.cache.commit(result.snapshot, result.etag);
        current = options.cache.get()!.snapshot;
        if (changed) {
          options.onSnapshot?.(structuredClone(current));
        }
      }
      lastSuccessAt = now().toISOString();
      return publish({
        state: "online",
        lastSuccessAt,
        syncRevision: current.syncRevision,
      });
    } catch (error) {
      if (error instanceof SyncClientError && error.status === 401) {
        return publish({ state: "revoked", errorCode: "revoked", action: "reconnect" });
      }
      let errorCode: CoreSyncStatus["errorCode"] = "offline";
      if (
        error instanceof SnapshotPolicyError ||
        error instanceof SnapshotCacheValidationError ||
        (error instanceof SyncClientError && error.kind === "protocol")
      ) {
        errorCode = "invalid_snapshot";
      } else if (!(error instanceof SyncClientError)) {
        errorCode = "cache_write_failed";
      }
      return publish({
        state: current ? "stale" : "error",
        ...(lastSuccessAt ? { lastSuccessAt } : {}),
        ...(current ? { syncRevision: current.syncRevision } : {}),
        errorCode,
        action: "retry",
      });
    }
  }

  function syncNow(): Promise<CoreSyncStatus> {
    if (currentStatus.state === "revoked") {
      return Promise.resolve({ ...currentStatus });
    }
    if (!inFlight) {
      inFlight = synchronize().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  }

  return {
    start: async () => {
      if (!stopped) {
        return;
      }
      stopped = false;
      await syncNow();
      schedule();
    },
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimer(timer);
        timer = undefined;
      }
    },
    syncNow,
    status: () => ({ ...currentStatus }),
    snapshot: () => (current ? structuredClone(current) : undefined),
    resetCache: () => {
      options.cache.clear();
      current = undefined;
      lastSuccessAt = undefined;
    },
    disconnect: () => {
      stopped = true;
      if (timer) {
        clearTimer(timer);
        timer = undefined;
      }
      options.connection.disconnect();
      options.cache.clear();
      current = undefined;
      lastSuccessAt = undefined;
      publish({ state: "disconnected" });
    },
  };
}
