import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import {
  SyncHostConfigError,
  createSyncHostConfig,
  inspectSyncHostStorage,
  parseSyncHostConfig,
  readSyncHostConfig,
  syncHostConfigPath,
  writeSyncHostConfig,
} from "./sync-host-config.ts";

test("Sync Host config accepts the product loopback origin and canonical HTTPS origins", () => {
  assert.deepEqual(createSyncHostConfig(), {
    schemaVersion: 1,
    publicOrigin: "http://127.0.0.1:4518",
  });
  assert.deepEqual(createSyncHostConfig("https://Sync.Example.com:8443/"), {
    schemaVersion: 1,
    publicOrigin: "https://sync.example.com:8443",
  });
});

test("Sync Host config rejects origins that widen or confuse the network boundary", () => {
  for (const origin of [
    "http://sync.example.com",
    "http://localhost:4518",
    "http://127.0.0.1:4519",
    "https://user:secret@sync.example.com",
    "https://sync.example.com/admin",
    "https://sync.example.com/?setup=secret",
    "https://sync.example.com/#secret",
    "ftp://sync.example.com",
    "not a URL",
  ]) {
    assert.throws(() => createSyncHostConfig(origin), SyncHostConfigError, origin);
  }
});

test("persisted Sync Host config is strict and canonical", () => {
  assert.deepEqual(
    parseSyncHostConfig({ schemaVersion: 1, publicOrigin: "https://sync.example.com" }),
    { schemaVersion: 1, publicOrigin: "https://sync.example.com" },
  );
  for (const value of [
    null,
    {},
    { schemaVersion: 2, publicOrigin: "https://sync.example.com" },
    { schemaVersion: 1, publicOrigin: "https://SYNC.example.com/" },
    { schemaVersion: 1, publicOrigin: "https://sync.example.com", extra: true },
  ]) {
    assert.throws(() => parseSyncHostConfig(value), SyncHostConfigError);
  }
});

test("Sync Host config writes privately and atomically", async (t) => {
  const root = temporaryDirectory("cinba-sync-host-config-", t);
  const path = join(root, "nested", "sync.json");
  await writeSyncHostConfig(path, createSyncHostConfig("https://sync.example.com"));
  assert.deepEqual(await readSyncHostConfig(path), {
    schemaVersion: 1,
    publicOrigin: "https://sync.example.com",
  });
  assert.equal(
    await readFile(path, "utf8"),
    '{\n  "schemaVersion": 1,\n  "publicOrigin": "https://sync.example.com"\n}\n',
  );
  const siblings = await import("node:fs/promises").then(({ readdir }) =>
    readdir(join(root, "nested")),
  );
  assert.deepEqual(siblings, ["sync.json"]);
});

test("missing config is distinct from malformed config", async (t) => {
  const root = temporaryDirectory("cinba-sync-host-invalid-", t);
  const path = join(root, "sync.json");
  assert.equal(await readSyncHostConfig(path), undefined);
  await writeFile(path, "{}\n");
  await assert.rejects(readSyncHostConfig(path), SyncHostConfigError);
});

test("Host storage inspection distinguishes committed and repair states", async (t) => {
  const root = temporaryDirectory("cinba-sync-host-state-", t);
  const configurationDirectory = join(root, "config");
  const syncDataDirectory = join(root, "data", "Sync");
  assert.equal(
    syncHostConfigPath({ configurationDirectory }),
    join(configurationDirectory, "sync.json"),
  );
  assert.deepEqual(await inspectSyncHostStorage({ configurationDirectory, syncDataDirectory }), {
    state: "not-created",
  });

  await mkdir(syncDataDirectory, { recursive: true });
  assert.deepEqual(await inspectSyncHostStorage({ configurationDirectory, syncDataDirectory }), {
    state: "orphaned-authority",
  });

  const path = syncHostConfigPath({ configurationDirectory });
  await writeSyncHostConfig(path, createSyncHostConfig());
  assert.deepEqual(await inspectSyncHostStorage({ configurationDirectory, syncDataDirectory }), {
    state: "created",
    config: createSyncHostConfig(),
  });

  await import("node:fs/promises").then(({ rm }) => rm(syncDataDirectory, { recursive: true }));
  assert.deepEqual(await inspectSyncHostStorage({ configurationDirectory, syncDataDirectory }), {
    state: "missing-authority",
    config: createSyncHostConfig(),
  });

  await writeFile(path, "{}\n");
  const invalid = await inspectSyncHostStorage({ configurationDirectory, syncDataDirectory });
  assert.equal(invalid.state, "invalid-config");
  await access(path);
});
