import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import { createSyncConnectionStore } from "./connection-store.ts";
import { createEnrollmentCoordinator } from "./enrollment-coordinator.ts";

test("enrollment persists pending state and an approval authenticates after restart", async (context) => {
  const directory = temporaryDirectory("cinba-sync-connection-", context);
  const path = join(directory, "connection.json");
  const store = createSyncConnectionStore(path);
  let approved = false;
  const coordinator = createEnrollmentCoordinator({
    store,
    remoteFor: () => ({
      create: async () => ({
        version: 1,
        enrollmentId: "enrollment-id",
        enrollmentSecret: "enrollment-secret",
        expiresAt: "2026-09-16T12:00:00.000Z",
      }),
      status: async () =>
        approved
          ? {
              version: 1,
              status: "approved" as const,
              coreId: "core-id",
              coreCredential: "core-credential",
            }
          : { version: 1, status: "pending" as const },
    }),
  });

  await coordinator.begin({
    serverUrl: "http://127.0.0.1:4518",
    sources: { settings: "sync", credentials: "local" },
    request: {
      version: 1,
      name: "Windows Core",
      platform: "windows",
      appVersion: "1.0.0",
      credentialSource: "local",
    },
  });
  assert.equal(createSyncConnectionStore(path).get()?.pending?.id, "enrollment-id");
  assert.equal((await coordinator.poll())?.status, "pending");

  approved = true;
  assert.equal((await coordinator.poll())?.status, "approved");
  assert.deepEqual(createSyncConnectionStore(path).get()?.core, {
    id: "core-id",
    credential: "core-credential",
  });
  store.setSources({ settings: "sync", credentials: "sync" });
  assert.deepEqual(createSyncConnectionStore(path).get()?.sources, {
    settings: "sync",
    credentials: "sync",
  });
  assert.deepEqual(createSyncConnectionStore(path).get()?.core, {
    id: "core-id",
    credential: "core-credential",
  });
});

test("rejection, cancellation, and disconnect delete only Sync connection state", async (context) => {
  const directory = temporaryDirectory("cinba-sync-disconnect-", context);
  const path = join(directory, "connection.json");
  const localSettings = join(directory, "local-settings.json");
  const localCredentials = join(directory, "credentials.json");
  writeFileSync(localSettings, "settings");
  writeFileSync(localCredentials, "credentials");
  const store = createSyncConnectionStore(path);
  const coordinator = createEnrollmentCoordinator({
    store,
    remoteFor: () => ({
      create: async () => ({
        version: 1,
        enrollmentId: "id",
        enrollmentSecret: "secret",
        expiresAt: "2026-09-16T12:00:00.000Z",
      }),
      status: async () => ({ version: 1, status: "rejected" }),
    }),
  });
  const begin = () =>
    coordinator.begin({
      serverUrl: "https://sync.example.test",
      sources: { settings: "sync", credentials: "sync" },
      request: {
        version: 1,
        name: "Core",
        platform: "linux",
        appVersion: "1",
        credentialSource: "sync",
      },
    });

  await begin();
  await coordinator.poll();
  assert.equal(existsSync(path), false);
  await begin();
  coordinator.cancel();
  assert.equal(existsSync(path), false);
  assert.equal(readFileSync(localSettings, "utf8"), "settings");
  assert.equal(readFileSync(localCredentials, "utf8"), "credentials");
});

test("waiting polls until approval without creating overlapping enrollment state", async (context) => {
  const directory = temporaryDirectory("cinba-sync-wait-", context);
  const store = createSyncConnectionStore(join(directory, "connection.json"));
  let polls = 0;
  const coordinator = createEnrollmentCoordinator({
    store,
    sleep: async () => undefined,
    remoteFor: () => ({
      create: async () => ({
        version: 1,
        enrollmentId: "id",
        enrollmentSecret: "secret",
        expiresAt: "2026-09-16T12:00:00.000Z",
      }),
      status: async () => {
        polls += 1;
        return polls === 1
          ? { version: 1, status: "pending" as const }
          : {
              version: 1,
              status: "approved" as const,
              coreId: "core",
              coreCredential: "credential",
            };
      },
    }),
  });
  await coordinator.begin({
    serverUrl: "https://sync.example.test",
    sources: { settings: "sync", credentials: "local" },
    request: {
      version: 1,
      name: "Core",
      platform: "macos",
      appVersion: "1",
      credentialSource: "local",
    },
  });
  assert.equal((await coordinator.wait())?.status, "approved");
  assert.equal(polls, 2);
});

test("concurrent begin calls create only one remote enrollment", async (context) => {
  const directory = temporaryDirectory("cinba-sync-concurrent-enrollment-", context);
  const store = createSyncConnectionStore(join(directory, "connection.json"));
  let release!: () => void;
  const created = new Promise<void>((resolve) => {
    release = resolve;
  });
  let creates = 0;
  const coordinator = createEnrollmentCoordinator({
    store,
    remoteFor: () => ({
      create: async () => {
        creates += 1;
        await created;
        return {
          version: 1,
          enrollmentId: "id",
          enrollmentSecret: "secret",
          expiresAt: "2026-09-16T12:00:00.000Z",
        };
      },
      status: async () => ({ version: 1, status: "pending" }),
    }),
  });
  const options = {
    serverUrl: "https://sync.example.test",
    sources: { settings: "sync", credentials: "local" } as const,
    request: {
      version: 1 as const,
      name: "Core",
      platform: "macos" as const,
      appVersion: "1",
      credentialSource: "local" as const,
    },
  };

  const first = coordinator.begin(options);
  await assert.rejects(coordinator.begin(options), /already exists/);
  assert.equal(creates, 1);
  release();
  await first;
});

test("an invalid existing connection is preserved and makes the store read-only", (context) => {
  const directory = temporaryDirectory("cinba-sync-connection-", context);
  const path = join(directory, "connection.json");
  writeFileSync(path, '{"version":2,"credential":"keep-me"}');
  const store = createSyncConnectionStore(path);
  assert.ok(store.problem());
  assert.throws(() => store.disconnect());
  assert.match(readFileSync(path, "utf8"), /keep-me/);
});
