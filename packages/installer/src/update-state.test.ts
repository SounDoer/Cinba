import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
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

test("update state persists one strictly parsed ready candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-state-"));
  try {
    await writeUpdateState(root, ready);
    assert.deepEqual(await readUpdateState(root), ready);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("successful installation replaces stale ready state with the new current version", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-installed-"));
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installation failure retains the verified candidate for retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-install-failed-"));
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
