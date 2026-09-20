import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import {
  CoreAuthenticationError,
  EnrollmentAuthenticationError,
  createSyncStore,
} from "./sync-store.ts";

function request(name: string, credentialSource: "local" | "sync" = "sync") {
  return {
    version: 1 as const,
    name,
    platform: "windows" as const,
    appVersion: "0.0.0",
    credentialSource,
  };
}

async function approve(
  store: ReturnType<typeof createSyncStore>,
  name: string,
  credentialSource: "local" | "sync" = "sync",
) {
  const enrollment = await store.createEnrollment(request(name, credentialSource));
  await store.decideEnrollment(enrollment.enrollmentId, "approve");
  const status = await store.enrollmentStatus(enrollment.enrollmentId, enrollment.enrollmentSecret);
  assert.equal(status.status, "approved");
  if (status.status !== "approved") {
    throw new Error("expected approved enrollment");
  }
  return status;
}

test("pending enrollment transitions to rejected or expired and stops polling", async (t) => {
  const directory = temporaryDirectory("cinba-enrollment-", t);
  let now = Date.UTC(2026, 8, 16);
  const store = createSyncStore(directory, { now: () => new Date(now) });
  const rejected = await store.createEnrollment(request("Rejected"));
  assert.equal(
    (await store.enrollmentStatus(rejected.enrollmentId, rejected.enrollmentSecret)).status,
    "pending",
  );
  await store.decideEnrollment(rejected.enrollmentId, "reject");
  assert.equal(
    (await store.enrollmentStatus(rejected.enrollmentId, rejected.enrollmentSecret)).status,
    "rejected",
  );
  await assert.rejects(
    store.enrollmentStatus(rejected.enrollmentId, rejected.enrollmentSecret),
    EnrollmentAuthenticationError,
  );

  const expired = await store.createEnrollment(request("Expired"));
  now += 11 * 60_000;
  assert.equal(
    (await store.enrollmentStatus(expired.enrollmentId, expired.enrollmentSecret)).status,
    "expired",
  );
  assert.deepEqual(store.pendingEnrollments().enrollments, []);
});

test("approval delivers one Core credential once and stores only its salted hash", async (t) => {
  const directory = temporaryDirectory("cinba-enrollment-", t);
  const store = createSyncStore(directory);
  const enrollment = await store.createEnrollment(request("Studio"));
  await assert.rejects(
    store.enrollmentStatus(enrollment.enrollmentId, "wrong-secret"),
    EnrollmentAuthenticationError,
  );
  await store.decideEnrollment(enrollment.enrollmentId, "approve");
  const approved = await store.enrollmentStatus(
    enrollment.enrollmentId,
    enrollment.enrollmentSecret,
  );
  assert.equal(approved.status, "approved");
  if (approved.status !== "approved") {
    return;
  }
  const disk = readFileSync(join(directory, "state.json"), "utf8");
  assert.equal(disk.includes(approved.coreCredential), false);
  assert.equal(store.connectedCores().cores[0]?.id, approved.coreId);
  await assert.rejects(
    store.enrollmentStatus(enrollment.enrollmentId, enrollment.enrollmentSecret),
    EnrollmentAuthenticationError,
  );
});

test("Core credentials are isolated, revocation is immediate, and Local cores never get secrets", async (t) => {
  const directory = temporaryDirectory("cinba-enrollment-", t);
  const store = createSyncStore(directory);
  await store.setCredential("deepseek", "shared-secret");
  const sharedCore = await approve(store, "Shared", "sync");
  const localCore = await approve(store, "Local", "local");

  assert.deepEqual((await store.snapshotForCore(sharedCore.coreCredential)).credentials, {
    deepseek: "shared-secret",
  });
  assert.equal((await store.snapshotForCore(localCore.coreCredential)).credentials, undefined);
  await assert.rejects(
    store.snapshotForCore(`${sharedCore.coreId}.${localCore.coreCredential.split(".")[1]}`),
    CoreAuthenticationError,
  );

  await store.revokeCore(sharedCore.coreId);
  await assert.rejects(store.snapshotForCore(sharedCore.coreCredential), CoreAuthenticationError);
  assert.equal((await store.snapshotForCore(localCore.coreCredential)).version, 1);
});

test("capability reports produce an explicit partial-support model catalog", async (t) => {
  const directory = temporaryDirectory("cinba-enrollment-", t);
  const store = createSyncStore(directory);
  const first = await approve(store, "First");
  const second = await approve(store, "Second");
  await store.reportCapabilities(first.coreCredential, {
    version: 1,
    appVersion: "1.0.0",
    capabilities: {
      version: 1,
      providers: [{ id: "deepseek", name: "DeepSeek", authKind: "api-key" }],
      models: [{ provider: "deepseek", id: "shared-model" }],
    },
  });
  await store.reportCapabilities(second.coreCredential, {
    version: 1,
    appVersion: "2.0.0",
    capabilities: {
      version: 1,
      providers: [],
      models: [{ provider: "openai", id: "second-only" }],
    },
  });

  assert.deepEqual(store.modelCatalog(), {
    version: 1,
    models: [
      {
        model: { provider: "deepseek", id: "shared-model" },
        supportedCoreIds: [first.coreId],
        unsupportedCoreIds: [second.coreId],
      },
      {
        model: { provider: "openai", id: "second-only" },
        supportedCoreIds: [second.coreId],
        unsupportedCoreIds: [first.coreId],
      },
    ],
  });
});
