import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { type PlatformServiceAdapter, resolveProductPaths } from "@cinba/installer";
import { temporaryDirectory } from "@cinba/test-support";
import {
  createSyncHostConfig,
  formatProductSyncHostStatus,
  inspectProductSyncHost,
  syncHostConfigPath,
  writeSyncHostConfig,
} from "./index.ts";

test("human Host status names an installation that has not been created", () => {
  assert.equal(
    formatProductSyncHostStatus({ schemaVersion: 1, state: "not-created" }),
    "Cinba Sync Host: not created",
  );
});

test("human Host status explains why an installation needs repair", () => {
  assert.equal(
    formatProductSyncHostStatus({
      schemaVersion: 1,
      state: "repair-required",
      reason: "invalid-config",
    }),
    "Cinba Sync Host: repair required\n  Reason: invalid config",
  );
});

test("human Host status describes a created remote Host without inventing health", () => {
  assert.equal(
    formatProductSyncHostStatus({
      schemaVersion: 1,
      state: "created",
      publicOrigin: "https://sync.example.com",
      availability: "remote-https",
      mode: "disabled",
      running: false,
      healthy: null,
    }),
    [
      "Cinba Sync Host: created",
      "  Public origin: https://sync.example.com",
      "  Availability: Remote HTTPS",
      "  Mode: disabled",
      "  Service: stopped",
    ].join("\n"),
  );
});

test("human Host status reports local-only availability and known health", () => {
  assert.equal(
    formatProductSyncHostStatus({
      schemaVersion: 1,
      state: "created",
      publicOrigin: "http://127.0.0.1:4518",
      availability: "this-device-only",
      mode: "background",
      running: true,
      healthy: true,
    }),
    [
      "Cinba Sync Host: created",
      "  Public origin: http://127.0.0.1:4518",
      "  Availability: This device only",
      "  Mode: background",
      "  Service: running",
      "  Health: healthy",
    ].join("\n"),
  );
});

function nativeLayout(root: string) {
  if (
    process.platform !== "win32" &&
    process.platform !== "darwin" &&
    process.platform !== "linux"
  ) {
    throw new Error(`unsupported test platform: ${process.platform}`);
  }
  const environment = process.platform === "win32" ? { LOCALAPPDATA: root } : {};
  return {
    options: { platform: process.platform, homeDirectory: root, environment },
    paths: resolveProductPaths({
      platform: process.platform,
      homeDirectory: root,
      environment,
    }),
  };
}

function stoppedServiceAdapter(): PlatformServiceAdapter {
  return {
    inspect: async () => ({ registered: false, running: false }),
    install: async () => undefined,
    remove: async () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
  };
}

test("an installation without a Sync Host reports not created without initializing storage", async (t) => {
  const homeDirectory = temporaryDirectory("cinba-sync-host-manager-", t);
  const { options, paths } = nativeLayout(homeDirectory);
  const status = await inspectProductSyncHost(options);
  assert.deepEqual(status, { schemaVersion: 1, state: "not-created" });

  await assert.rejects(access(paths.configurationDirectory), { code: "ENOENT" });
  await assert.rejects(access(paths.syncDataDirectory), { code: "ENOENT" });
});

test("an authority without committed Host config requires explicit repair", async (t) => {
  const root = temporaryDirectory("cinba-sync-host-orphan-", t);
  const { options, paths } = nativeLayout(root);
  await mkdir(paths.syncDataDirectory, { recursive: true });

  assert.deepEqual(await inspectProductSyncHost(options), {
    schemaVersion: 1,
    state: "repair-required",
    reason: "orphaned-authority",
  });
});

test("committed Host config without its authority requires explicit repair", async (t) => {
  const root = temporaryDirectory("cinba-sync-host-missing-authority-", t);
  const { options, paths } = nativeLayout(root);
  await writeSyncHostConfig(syncHostConfigPath(paths), createSyncHostConfig());

  assert.deepEqual(await inspectProductSyncHost(options), {
    schemaVersion: 1,
    state: "repair-required",
    reason: "missing-authority",
  });
});

test("invalid Host config is preserved and reported as requiring repair", async (t) => {
  const root = temporaryDirectory("cinba-sync-host-invalid-config-", t);
  const { options, paths } = nativeLayout(root);
  const configPath = syncHostConfigPath(paths);
  await mkdir(paths.configurationDirectory, { recursive: true });
  await writeFile(configPath, '{"schemaVersion":2,"publicOrigin":"https://sync.example.com"}\n');

  assert.deepEqual(await inspectProductSyncHost(options), {
    schemaVersion: 1,
    state: "repair-required",
    reason: "invalid-config",
  });
  assert.equal(
    await readFile(configPath, "utf8"),
    '{"schemaVersion":2,"publicOrigin":"https://sync.example.com"}\n',
  );
});

test("a committed Host reports its origin, availability, and lifecycle", async (t) => {
  const root = temporaryDirectory("cinba-sync-host-created-", t);
  const { options, paths } = nativeLayout(root);
  await mkdir(paths.syncDataDirectory, { recursive: true });
  await writeSyncHostConfig(
    syncHostConfigPath(paths),
    createSyncHostConfig("https://sync.example.com"),
  );

  assert.deepEqual(await inspectProductSyncHost({ ...options, adapter: stoppedServiceAdapter() }), {
    schemaVersion: 1,
    state: "created",
    publicOrigin: "https://sync.example.com",
    availability: "remote-https",
    mode: "disabled",
    running: false,
    healthy: null,
  });
});
