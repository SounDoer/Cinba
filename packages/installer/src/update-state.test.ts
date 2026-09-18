import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseUpdateState, readUpdateState, writeUpdateState } from "./update-state.ts";

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
  assert.throws(() => parseUpdateState({ ...ready, progress: 50 }), /fields are invalid/);
});
