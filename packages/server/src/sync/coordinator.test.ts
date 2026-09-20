import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type SnapshotResult, SyncClientError } from "@cinba/sync-client";
import type { SyncSnapshot } from "@cinba/sync-contract";
import { temporaryDirectory } from "@cinba/test-support";
import { createSyncConnectionStore } from "./connection-store.ts";
import { createSyncCoordinator } from "./coordinator.ts";
import { createSnapshotCache } from "./snapshot-cache.ts";

function snapshot(revision: number, credentials?: Record<string, string>): SyncSnapshot {
  return {
    version: 1,
    syncRevision: revision,
    settingsRevision: revision,
    settings: { version: 1, webTools: { searchPrimary: "auto" } },
    ...(credentials === undefined ? {} : { credentials }),
  };
}

function connected(directory: string, credentialSource: "local" | "sync" = "local") {
  const store = createSyncConnectionStore(join(directory, "sync-connection.json"));
  store.begin({
    serverUrl: "https://sync.example.test",
    sources: { settings: "sync", credentials: credentialSource },
    enrollment: { id: "pending", secret: "secret", expiresAt: "2026-09-16T12:00:00.000Z" },
  });
  store.approve({ id: "core", credential: "credential" });
  return store;
}

test("startup, manual sync, and jitter polling coalesce requests and skip unchanged broadcasts", async (context) => {
  const directory = temporaryDirectory("cinba-sync-coordinator-", context);
  const store = connected(directory);
  const cache = createSnapshotCache(join(directory, "sync-snapshot.json"));
  let calls = 0;
  let broadcasts = 0;
  let scheduled: (() => void) | undefined;
  let scheduledDelay = 0;
  let release!: (result: SnapshotResult) => void;
  let next = new Promise<SnapshotResult>((resolve) => (release = resolve));
  const coordinator = createSyncCoordinator({
    connection: store,
    cache,
    remoteFor: () => ({
      snapshot: async () => {
        calls += 1;
        return next;
      },
    }),
    onSnapshot: () => {
      broadcasts += 1;
    },
    pollIntervalMs: 1_000,
    random: () => 0,
    setTimer: (callback, delay) => {
      scheduled = callback;
      scheduledDelay = delay;
      return { unref() {} } as NodeJS.Timeout;
    },
    clearTimer: () => undefined,
  });

  const startup = coordinator.start();
  const manual = coordinator.syncNow();
  assert.equal(calls, 1);
  release({ status: "updated", snapshot: snapshot(1), etag: '"sync-1"' });
  await Promise.all([startup, manual]);
  assert.equal(broadcasts, 1);
  assert.equal(scheduledDelay, 800);

  next = Promise.resolve({ status: "unchanged", etag: '"sync-1"' });
  scheduled?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(broadcasts, 1);
  coordinator.stop();
});

test("offline startup keeps last-known-good as stale and later success recovers", async (context) => {
  const directory = temporaryDirectory("cinba-sync-offline-", context);
  const cachePath = join(directory, "sync-snapshot.json");
  createSnapshotCache(cachePath, { now: () => new Date("2026-09-16T09:00:00.000Z") }).commit(
    snapshot(4),
  );
  let online = false;
  const coordinator = createSyncCoordinator({
    connection: connected(directory),
    cache: createSnapshotCache(cachePath),
    remoteFor: () => ({
      snapshot: async () => {
        if (!online) {
          throw new SyncClientError({ kind: "transport", message: "offline", retryable: true });
        }
        return { status: "updated", snapshot: snapshot(5) };
      },
    }),
    now: () => new Date("2026-09-16T10:00:00.000Z"),
  });
  assert.equal(coordinator.status().state, "stale");
  assert.equal((await coordinator.syncNow()).state, "stale");
  assert.equal(coordinator.snapshot()?.syncRevision, 4);
  assert.equal(coordinator.status().lastSuccessAt, "2026-09-16T09:00:00.000Z");
  online = true;
  assert.equal((await coordinator.syncNow()).state, "online");
  assert.equal(coordinator.snapshot()?.syncRevision, 5);
});

test("invalid, downgraded, and source-mismatched Snapshots never replace good cache", async (context) => {
  const directory = temporaryDirectory("cinba-sync-invalid-", context);
  const cache = createSnapshotCache(join(directory, "sync-snapshot.json"));
  cache.commit(snapshot(3));
  let result: SnapshotResult = { status: "updated", snapshot: snapshot(2) };
  const coordinator = createSyncCoordinator({
    connection: connected(directory),
    cache,
    remoteFor: () => ({ snapshot: async () => result }),
  });
  assert.equal((await coordinator.syncNow()).errorCode, "invalid_snapshot");
  assert.equal(cache.get()?.snapshot.syncRevision, 3);

  result = { status: "updated", snapshot: snapshot(4, { provider: "must-not-cache" }) };
  assert.equal((await coordinator.syncNow()).errorCode, "invalid_snapshot");
  assert.equal(cache.get()?.snapshot.syncRevision, 3);

  result = {
    status: "updated",
    snapshot: { ...snapshot(4), version: 2 } as unknown as SyncSnapshot,
  };
  assert.equal((await coordinator.syncNow()).errorCode, "invalid_snapshot");
  assert.equal(cache.get()?.snapshot.syncRevision, 3);
});

test("write failure preserves old memory, revocation stops retries, and disconnect has exact scope", async (context) => {
  const directory = temporaryDirectory("cinba-sync-boundaries-", context);
  const connection = connected(directory);
  const cachePath = join(directory, "sync-snapshot.json");
  const seed = createSnapshotCache(cachePath);
  seed.commit(snapshot(1));
  const cache = createSnapshotCache(cachePath, {
    write: () => {
      throw new Error("disk full");
    },
  });
  let calls = 0;
  let revoked = false;
  const coordinator = createSyncCoordinator({
    connection,
    cache,
    remoteFor: () => ({
      snapshot: async () => {
        calls += 1;
        if (revoked) {
          throw new SyncClientError({ kind: "http", message: "unauthorized", status: 401 });
        }
        return { status: "updated", snapshot: snapshot(2) };
      },
    }),
  });
  assert.equal((await coordinator.syncNow()).errorCode, "cache_write_failed");
  assert.equal(coordinator.snapshot()?.syncRevision, 1);
  revoked = true;
  assert.equal((await coordinator.syncNow()).state, "revoked");
  assert.equal((await coordinator.syncNow()).state, "revoked");
  assert.equal(calls, 2);

  const localSettings = join(directory, "local-settings.json");
  const localCredentials = join(directory, "credentials.json");
  const sessions = join(directory, "sessions.keep");
  for (const path of [localSettings, localCredentials, sessions]) {
    writeFileSync(path, "keep");
  }
  coordinator.disconnect();
  assert.equal(existsSync(join(directory, "sync-connection.json")), false);
  assert.equal(existsSync(cachePath), false);
  for (const path of [localSettings, localCredentials, sessions]) {
    assert.equal(existsSync(path), true);
  }
});

test("Shared Credentials mode requires a credential-bearing Snapshot", async (context) => {
  const directory = temporaryDirectory("cinba-sync-shared-", context);
  let result = snapshot(1);
  const coordinator = createSyncCoordinator({
    connection: connected(directory, "sync"),
    cache: createSnapshotCache(join(directory, "sync-snapshot.json")),
    remoteFor: () => ({ snapshot: async () => ({ status: "updated", snapshot: result }) }),
  });
  assert.equal((await coordinator.syncNow()).errorCode, "invalid_snapshot");
  result = snapshot(1, { deepseek: "shared-key" });
  assert.equal((await coordinator.syncNow()).state, "online");
  assert.equal(coordinator.snapshot()?.credentials?.deepseek, "shared-key");
});
