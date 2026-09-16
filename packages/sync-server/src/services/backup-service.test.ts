import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SyncMaintenanceError, createSyncStore } from "../store/sync-store.ts";
import { backupSyncState, inspectSyncState, restoreSyncState } from "./backup-service.ts";

const PASSWORD = "one-time-migration-password";

async function populatedState(root: string) {
  const store = createSyncStore(root);
  const setupCode = store.localSetupCode()!;
  assert.equal(await store.completeAdministratorSetup(setupCode, "administrator-password"), true);
  await store.setCredential("example", "provider-secret-value");
  await store.updateSettings(0, {
    version: 1,
    webTools: { searchPrimary: "brave" },
  });
  const enrollment = await store.createEnrollment({
    version: 1,
    name: "Test Core",
    platform: "linux",
    appVersion: "1.0.0",
    credentialSource: "sync",
  });
  await store.decideEnrollment(enrollment.enrollmentId, "approve");
  const approved = await store.enrollmentStatus(
    enrollment.enrollmentId,
    enrollment.enrollmentSecret,
  );
  assert.equal(approved.status, "approved");
  if (approved.status !== "approved") {
    throw new Error("expected approved enrollment");
  }
  return { store, coreCredential: approved.coreCredential };
}

test("an encrypted backup restores identity, authentication, revisions, and credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-sync-backup-"));
  const source = join(root, "source");
  const target = join(root, "target");
  const archive = join(root, "sync.backup");
  const { store, coreCredential } = await populatedState(source);
  const serverId = store.serverId();
  const keyText = readFileSync(join(source, "credential-key")).toString("base64");

  backupSyncState(source, archive, PASSWORD);
  const encrypted = readFileSync(archive, "utf8");
  for (const secret of [
    PASSWORD,
    "administrator-password",
    "provider-secret-value",
    coreCredential,
    keyText,
  ]) {
    assert.equal(encrypted.includes(secret), false);
  }

  restoreSyncState(target, archive, PASSWORD);
  const restored = createSyncStore(target);
  assert.equal(restored.serverId(), serverId);
  assert.equal(restored.verifyAdministratorPassword("administrator-password"), true);
  assert.equal(restored.settings().settingsRevision, 1);
  assert.equal(restored.credential("example"), "provider-secret-value");
  assert.equal(
    (await restored.snapshotForCore(coreCredential)).credentials?.example,
    "provider-secret-value",
  );
});

test("restore rejects bad passwords, damaged archives, unsupported versions, and nonempty targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-sync-restore-"));
  const source = join(root, "source");
  const archive = join(root, "sync.backup");
  await populatedState(source);
  backupSyncState(source, archive, PASSWORD);

  assert.throws(
    () => restoreSyncState(join(root, "wrong"), archive, "wrong-password-value"),
    /incorrect|integrity/,
  );
  const original = readFileSync(archive, "utf8");
  writeFileSync(join(root, "truncated"), original.slice(0, -10));
  assert.throws(
    () => restoreSyncState(join(root, "truncated-target"), join(root, "truncated"), PASSWORD),
    /malformed|truncated/,
  );
  const tampered = JSON.parse(original) as { cipher: { ciphertext: string } };
  tampered.cipher.ciphertext = `${tampered.cipher.ciphertext.slice(0, -4)}AAAA`;
  writeFileSync(join(root, "tampered"), JSON.stringify(tampered));
  assert.throws(
    () => restoreSyncState(join(root, "tampered-target"), join(root, "tampered"), PASSWORD),
    /integrity/,
  );
  writeFileSync(join(root, "unknown"), JSON.stringify({ kind: "cinba-sync-backup", version: 2 }));
  assert.throws(
    () => restoreSyncState(join(root, "unknown-target"), join(root, "unknown"), PASSWORD),
    /version/,
  );

  const target = join(root, "occupied");
  mkdirSync(target);
  writeFileSync(join(target, "marker"), "occupied");
  assert.throws(() => restoreSyncState(target, archive, PASSWORD), /not empty/);
});

test("forced restore preserves the previous target and maintenance rejects mutations", async () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-sync-force-"));
  const source = join(root, "source");
  const target = join(root, "target");
  const archive = join(root, "sync.backup");
  await populatedState(source);
  createSyncStore(target);
  const oldId = createSyncStore(target).serverId();
  backupSyncState(source, archive, PASSWORD);
  const preserved = restoreSyncState(target, archive, PASSWORD, { force: true });
  assert.ok(preserved);
  assert.equal(createSyncStore(preserved).serverId(), oldId);

  let readOnly = true;
  const store = createSyncStore(target, { readOnly: () => readOnly });
  assert.doesNotThrow(() => store.settings());
  await assert.rejects(() => store.setCredential("blocked", "secret"), SyncMaintenanceError);
  readOnly = false;
  await store.setCredential("allowed", "secret");
});

test("status reveals a Setup Code only before administrator setup", async () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-sync-status-"));
  assert.deepEqual(inspectSyncState(join(root, "missing")), { state: "absent" });
  const directory = join(root, "state");
  const store = createSyncStore(directory);
  const pending = inspectSyncState(directory);
  assert.equal(pending.state, "setup-required");
  assert.equal(pending.setupCode, store.localSetupCode());
  await store.completeAdministratorSetup(store.localSetupCode()!, "administrator-password");
  const ready = inspectSyncState(directory);
  assert.equal(ready.state, "ready");
  assert.equal("setupCode" in ready, false);
});
