import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import {
  AUTOMATIC_UPDATE_CHECK_INTERVAL_MS,
  automaticUpdateCheckIsDue,
  parseUpdateState,
  readUpdateState,
  recordUpdateInstallationResult,
  writeUpdateState,
} from "./update-state.ts";

const ready = {
  schemaVersion: 1 as const,
  phase: "ready" as const,
  currentVersion: "0.1.0",
  checkedAt: "2026-09-18T01:02:03.000Z",
  candidate: {
    version: "0.2.0",
    revision: "a".repeat(40),
    target: "windows-x64" as const,
    artifactPath: resolve("Cinba.exe"),
    size: 42,
    sha256: "b".repeat(64),
    releaseUrl: "https://github.com/SounDoer/Cinba/releases/tag/v0.2.0",
  },
  failure: null,
};

test("update state persists one strictly parsed ready candidate", async (t) => {
  const root = temporaryDirectory("cinba-update-state-", t);
  await writeUpdateState(root, ready);
  assert.deepEqual(await readUpdateState(root), ready);
});

test("update state rejects incomplete phases and unknown fields", () => {
  assert.throws(() => parseUpdateState({ ...ready, phase: "ready", candidate: null }), /candidate/);
  assert.throws(
    () => parseUpdateState({ ...ready, phase: "current", failure: "download-failed" }),
    /failure does not match/,
  );
  assert.throws(
    () =>
      parseUpdateState({
        ...ready,
        phase: "failed",
        candidate: null,
        failure: "installation-failed",
      }),
    /installation failure requires a candidate/,
  );
  assert.throws(() => parseUpdateState({ ...ready, progress: 50 }), /fields are invalid/);
});

test("system failures require an undownloaded candidate and no other phase accepts them", () => {
  for (const failure of ["system-incompatible", "system-unverified"] as const) {
    const blocked = {
      ...ready,
      phase: "failed",
      candidate: { ...ready.candidate, artifactPath: null },
      failure,
    };
    assert.deepEqual(parseUpdateState(blocked), blocked);
    assert.throws(() => parseUpdateState({ ...blocked, candidate: null }), /system failure/);
    assert.throws(
      () => parseUpdateState({ ...blocked, candidate: ready.candidate }),
      /artifactPath/,
    );
    assert.throws(() => parseUpdateState({ ...blocked, phase: "ready" }), /failure does not match/);
  }
  assert.throws(
    () =>
      parseUpdateState({
        ...ready,
        phase: "failed",
        candidate: { ...ready.candidate, artifactPath: null },
        failure: "installation-failed",
      }),
    /downloaded artifact/,
  );
});

test("automatic checks are shared and limited to once per day", () => {
  assert.equal(
    automaticUpdateCheckIsDue({
      state: ready,
      currentVersion: ready.currentVersion,
      now: new Date(Date.parse(ready.checkedAt) + AUTOMATIC_UPDATE_CHECK_INTERVAL_MS - 1),
    }),
    false,
  );
  assert.equal(
    automaticUpdateCheckIsDue({
      state: ready,
      currentVersion: ready.currentVersion,
      now: new Date(Date.parse(ready.checkedAt) + AUTOMATIC_UPDATE_CHECK_INTERVAL_MS),
    }),
    true,
  );
  assert.equal(
    automaticUpdateCheckIsDue({
      state: ready,
      currentVersion: "0.3.0",
      now: new Date(ready.checkedAt),
    }),
    true,
  );
});

test("an interrupted transient update operation can retry immediately", () => {
  assert.equal(
    automaticUpdateCheckIsDue({
      state: {
        ...ready,
        phase: "downloading",
        candidate: { ...ready.candidate, artifactPath: null },
      },
      currentVersion: ready.currentVersion,
      now: new Date(ready.checkedAt),
    }),
    true,
  );
});

test("successful installation replaces stale ready state with the new current version", async (t) => {
  const root = temporaryDirectory("cinba-update-installed-", t);
  await recordUpdateInstallationResult({
    stateDirectory: root,
    currentVersion: ready.currentVersion,
    candidate: ready.candidate,
    result: "installed",
    now: () => new Date("2026-09-18T02:00:00Z"),
  });
  const saved = await readUpdateState(root);
  assert.deepEqual(saved, {
    schemaVersion: 1,
    phase: "current",
    currentVersion: "0.2.0",
    checkedAt: "2026-09-18T02:00:00.000Z",
    candidate: null,
    failure: null,
  });
  assert.equal(
    automaticUpdateCheckIsDue({
      state: saved,
      currentVersion: "0.2.0",
      now: new Date("2026-09-18T03:00:00Z"),
    }),
    false,
  );
});

test("installation failure retains the verified candidate for retry", async (t) => {
  const root = temporaryDirectory("cinba-update-install-failed-", t);
  await recordUpdateInstallationResult({
    stateDirectory: root,
    currentVersion: ready.currentVersion,
    candidate: ready.candidate,
    result: "failed",
    now: () => new Date("2026-09-18T02:00:00Z"),
  });
  const saved = await readUpdateState(root);
  assert.equal(saved?.phase, "failed");
  assert.equal(saved?.failure, "installation-failed");
  assert.deepEqual(saved?.candidate, ready.candidate);
  assert.equal(saved?.currentVersion, "0.1.0");
});
