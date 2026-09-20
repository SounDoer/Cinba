import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { SyncSnapshot } from "@cinba/sync-contract";
import { temporaryDirectory } from "@cinba/test-support";
import { writeAtomicJson } from "../atomic-json-store.ts";
import { SnapshotCacheValidationError, createSnapshotCache } from "./snapshot-cache.ts";

function snapshot(revision: number): SyncSnapshot {
  return {
    version: 1,
    syncRevision: revision,
    settingsRevision: revision,
    settings: { version: 1, webTools: { searchPrimary: "auto" } },
  };
}

test("Snapshot cache persists a complete last-known-good and ignores an unchanged revision", (context) => {
  const directory = temporaryDirectory("cinba-sync-cache-", context);
  const path = join(directory, "snapshot.json");
  let writes = 0;
  const cache = createSnapshotCache(path, {
    now: () => new Date("2026-09-16T10:00:00.000Z"),
    write: (target, value, validate) => {
      writes += 1;
      writeAtomicJson(target, value, validate);
    },
  });
  assert.equal(cache.commit(snapshot(2), '"sync-2"'), true);
  assert.equal(cache.commit(snapshot(2), '"another-etag"'), false);
  assert.equal(writes, 1);
  assert.deepEqual(createSnapshotCache(path).get(), {
    snapshot: snapshot(2),
    etag: '"sync-2"',
    savedAt: "2026-09-16T10:00:00.000Z",
  });
});

test("a downgrade or failed atomic write leaves memory and disk on the old Snapshot", (context) => {
  const directory = temporaryDirectory("cinba-sync-cache-", context);
  const path = join(directory, "snapshot.json");
  const initial = createSnapshotCache(path);
  initial.commit(snapshot(3));
  const before = readFileSync(path, "utf8");
  assert.throws(() => initial.commit(snapshot(2)), SnapshotCacheValidationError);

  const failing = createSnapshotCache(path, {
    write: () => {
      throw new Error("disk full");
    },
  });
  assert.throws(() => failing.commit(snapshot(4)), /disk full/);
  assert.equal(failing.get()?.snapshot.syncRevision, 3);
  assert.equal(readFileSync(path, "utf8"), before);
});
