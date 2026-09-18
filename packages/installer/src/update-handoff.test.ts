import assert from "node:assert/strict";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import {
  UPDATE_HANDOFF_TTL_MS,
  assertUpdateHandoffMatchesReadyState,
  claimUpdateHandoff,
  createUpdateHandoff,
  parseUpdateHandoff,
  reapClaimedUpdateHandoffs,
  removeUpdateHandoff,
  updateHandoffPath,
  writeUpdateHandoff,
  writeUpdateHandoffRecoveringStale,
} from "./update-handoff.ts";
import { writeUpdateState } from "./update-state.ts";

const revision = "a".repeat(40);
const sha256 = "b".repeat(64);
const leaseToken = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-09-18T08:00:00.000Z");

function candidate(root: string) {
  return {
    version: "0.2.0",
    revision,
    target: "windows-x64" as const,
    artifactPath: resolve(root, "Cinba-0.2.0.exe"),
    size: 42,
    sha256,
    releaseUrl: "https://github.com/SounDoer/Cinba/releases/tag/v0.2.0",
  };
}

function desktopHandoff(root: string) {
  return createUpdateHandoff({
    id: "22222222-2222-4222-8222-222222222222",
    createdAt: now,
    surface: "desktop",
    blockingProcessId: 123,
    candidate: candidate(root),
    restart: {},
    leaseToken,
  });
}

test("update handoff schema is exact and validates surface-specific restart metadata", () => {
  const root = resolve("state");
  const handoff = desktopHandoff(root);
  assert.deepEqual(parseUpdateHandoff(handoff, { now }), handoff);
  assert.throws(
    () => parseUpdateHandoff({ ...handoff, extra: true }, { now }),
    /fields are invalid/,
  );
  assert.throws(
    () =>
      parseUpdateHandoff(
        { ...handoff, restart: { workingDirectory: resolve("project") } },
        { now },
      ),
    /desktop restart fields are invalid/,
  );
  assert.throws(
    () =>
      parseUpdateHandoff(
        {
          ...handoff,
          surface: "tui",
          restart: { workingDirectory: "relative" },
        },
        { now },
      ),
    /workingDirectory must be absolute/,
  );
  assert.throws(
    () => parseUpdateHandoff({ ...handoff, blockingProcessId: 0 }, { now }),
    /blockingProcessId must be a positive integer/,
  );
});

test("update handoff rejects stale and future timestamps", () => {
  const handoff = desktopHandoff(resolve("state"));
  assert.throws(
    () =>
      parseUpdateHandoff(handoff, {
        now: new Date(now.getTime() + UPDATE_HANDOFF_TTL_MS + 1),
      }),
    /expired/,
  );
  assert.throws(
    () =>
      parseUpdateHandoff(handoff, {
        now: new Date(now.getTime() - 1),
      }),
    /createdAt is in the future/,
  );
});

test("handoff uses a fixed absolute state path and an atomic private file", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-handoff-"));
  try {
    const handoff = desktopHandoff(root);
    const path = updateHandoffPath(root);
    assert.equal(isAbsolute(path), true);
    assert.throws(() => updateHandoffPath("relative"), /must be absolute/);
    await writeUpdateHandoff(root, handoff, { now });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), handoff);
    if (process.platform !== "win32") {
      assert.equal((await lstat(path)).mode & 0o777, 0o600);
    }
    const claimed = await claimUpdateHandoff(root, { now });
    assert.deepEqual(claimed.handoff, handoff);
    await assert.rejects(() => claimUpdateHandoff(root, { now }), /does not exist/);
    await removeUpdateHandoff(root, handoff.id, { now });
    await assert.rejects(() => access(claimed.claimedPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("handoff storage refuses a symbolic-link directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-handoff-link-"));
  try {
    const target = join(root, "outside");
    await mkdir(target);
    await symlink(
      target,
      join(root, "update-handoff"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      () => writeUpdateHandoff(root, desktopHandoff(root), { now }),
      /symbolic link/,
    );
    await assert.rejects(() => claimUpdateHandoff(root, { now }), /symbolic link/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claimed handoff must match every field of the current ready candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-handoff-ready-"));
  const handoff = desktopHandoff(root);
  try {
    await writeUpdateState(root, {
      schemaVersion: 1,
      phase: "ready",
      currentVersion: "0.1.0",
      checkedAt: now.toISOString(),
      candidate: handoff.candidate,
      failure: null,
    });
    await assertUpdateHandoffMatchesReadyState(root, handoff);
    const mismatches = [
      { version: "0.2.1" },
      { revision: "c".repeat(40) },
      { target: "macos-arm64" as const },
      { artifactPath: resolve(root, "other.exe") },
      { size: handoff.candidate.size + 1 },
      { sha256: "d".repeat(64) },
      { releaseUrl: "https://github.com/SounDoer/Cinba/releases/tag/v0.2.1" },
    ];
    for (const mismatch of mismatches) {
      await writeUpdateState(root, {
        schemaVersion: 1,
        phase: "ready",
        currentVersion: "0.1.0",
        checkedAt: now.toISOString(),
        candidate: { ...handoff.candidate, ...mismatch },
        failure: null,
      });
      await assert.rejects(
        () => assertUpdateHandoffMatchesReadyState(root, handoff),
        /does not match the ready update/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a crashed helper's expired handoff is reclaimed while the new lease is held", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-handoff-stale-"));
  const stale = desktopHandoff(root);
  const retryAt = new Date(now.getTime() + UPDATE_HANDOFF_TTL_MS + 1);
  const replacement = createUpdateHandoff({
    ...stale,
    id: "33333333-3333-4333-8333-333333333333",
    createdAt: retryAt,
    leaseToken: "44444444-4444-4444-8444-444444444444",
  });
  try {
    await writeUpdateHandoff(root, stale, { now });
    await writeUpdateHandoffRecoveringStale(root, replacement, {
      now: retryAt,
      currentLeaseToken: replacement.leaseToken,
    });
    assert.deepEqual(JSON.parse(await readFile(updateHandoffPath(root), "utf8")), replacement);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unexpired handoff is not replaced by a new lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-handoff-active-"));
  const active = desktopHandoff(root);
  const replacement = createUpdateHandoff({
    ...active,
    id: "33333333-3333-4333-8333-333333333333",
    createdAt: new Date(now.getTime() + 1),
    leaseToken: "44444444-4444-4444-8444-444444444444",
  });
  try {
    await writeUpdateHandoff(root, active, { now });
    await assert.rejects(
      () =>
        writeUpdateHandoffRecoveringStale(root, replacement, {
          now: new Date(now.getTime() + 1),
          currentLeaseToken: replacement.leaseToken,
        }),
      /active update handoff already exists/,
    );
    assert.deepEqual(JSON.parse(await readFile(updateHandoffPath(root), "utf8")), active);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed ordinary handoff can be recovered only while a different lease is held", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-handoff-malformed-"));
  const replacement = desktopHandoff(root);
  try {
    await mkdir(join(root, "update-handoff"), { recursive: true });
    await writeFile(updateHandoffPath(root), '{"leaseToken":"old","broken":true}');
    await writeUpdateHandoffRecoveringStale(root, replacement, {
      now,
      currentLeaseToken: replacement.leaseToken,
    });
    assert.deepEqual(JSON.parse(await readFile(updateHandoffPath(root), "utf8")), replacement);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale recovery unlinks a handoff directory symlink without following it", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-handoff-recover-link-"));
  const outside = await mkdtemp(join(tmpdir(), "cinba-update-handoff-outside-"));
  const sentinel = join(outside, "keep.txt");
  try {
    await writeFile(sentinel, "keep");
    await symlink(
      outside,
      join(root, "update-handoff"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const replacement = desktopHandoff(root);
    await writeUpdateHandoffRecoveringStale(root, replacement, {
      now,
      currentLeaseToken: replacement.leaseToken,
    });
    await access(sentinel);
    assert.equal((await lstat(join(root, "update-handoff"))).isSymbolicLink(), false);
    assert.deepEqual(JSON.parse(await readFile(updateHandoffPath(root), "utf8")), replacement);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("an old worker cannot delete a newer handoff id", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-handoff-id-"));
  const current = desktopHandoff(root);
  try {
    await writeUpdateHandoff(root, current, { now });
    await removeUpdateHandoff(root, "33333333-3333-4333-8333-333333333333", { now });
    assert.deepEqual(JSON.parse(await readFile(updateHandoffPath(root), "utf8")), current);
    await removeUpdateHandoff(root, current.id, { now });
    await assert.rejects(() => access(updateHandoffPath(root)), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conditional handoff removal requires a strict UUID", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-handoff-remove-id-"));
  const current = desktopHandoff(root);
  try {
    await writeUpdateHandoff(root, current, { now });
    await assert.rejects(
      () => removeUpdateHandoff(root, "../handoff", { now }),
      /id must be a UUID/,
    );
    assert.deepEqual(JSON.parse(await readFile(updateHandoffPath(root), "utf8")), current);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the next lease reaps an expired claimed record left by a crashed helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-claimed-expired-"));
  const stale = desktopHandoff(root);
  const retryAt = new Date(now.getTime() + UPDATE_HANDOFF_TTL_MS + 1);
  try {
    await writeUpdateHandoff(root, stale, { now });
    const claimed = await claimUpdateHandoff(root, { now });
    const result = await reapClaimedUpdateHandoffs(root, {
      now: retryAt,
      currentLeaseToken: "44444444-4444-4444-8444-444444444444",
    });
    assert.deepEqual(result, { removed: [stale.id], retained: [], warnings: [] });
    await assert.rejects(() => access(claimed.claimedPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claimed scan retains a fresh diagnostic record without blocking new handoff state", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-claimed-fresh-"));
  const fresh = desktopHandoff(root);
  try {
    await writeUpdateHandoff(root, fresh, { now });
    const claimed = await claimUpdateHandoff(root, { now });
    const result = await reapClaimedUpdateHandoffs(root, {
      now: new Date(now.getTime() + 1),
      currentLeaseToken: "44444444-4444-4444-8444-444444444444",
    });
    assert.deepEqual(result, { removed: [], retained: [fresh.id], warnings: [] });
    await access(claimed.claimedPath);
    const replacement = createUpdateHandoff({
      ...fresh,
      id: "33333333-3333-4333-8333-333333333333",
      createdAt: new Date(now.getTime() + 1),
      leaseToken: "44444444-4444-4444-8444-444444444444",
    });
    await writeUpdateHandoff(root, replacement, { now: new Date(now.getTime() + 1) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a new handoff never reuses an existing claimed record id", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-claimed-same-id-"));
  const existing = desktopHandoff(root);
  try {
    await writeUpdateHandoff(root, existing, { now });
    await claimUpdateHandoff(root, { now });
    await assert.rejects(
      () => writeUpdateHandoff(root, existing, { now }),
      /claimed update handoff with the same id already exists/,
    );
    await assert.rejects(() => access(updateHandoffPath(root)), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claimed scan removes mismatched and malformed direct files without touching unrelated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-claimed-invalid-"));
  const record = desktopHandoff(root);
  const otherId = "33333333-3333-4333-8333-333333333333";
  const directory = join(root, "update-handoff");
  const unrelated = join(directory, "notes.json");
  try {
    await writeUpdateHandoff(root, record, { now });
    const claimed = await claimUpdateHandoff(root, { now });
    const mismatched = join(directory, `claimed-${otherId}.json`);
    await rename(claimed.claimedPath, mismatched);
    const malformedId = "55555555-5555-4555-8555-555555555555";
    const malformed = join(directory, `claimed-${malformedId}.json`);
    await writeFile(malformed, "{broken");
    await writeFile(unrelated, "keep");

    const result = await reapClaimedUpdateHandoffs(root, {
      now,
      currentLeaseToken: "44444444-4444-4444-8444-444444444444",
    });

    assert.deepEqual(result.removed, [malformedId, otherId].toSorted());
    assert.equal(result.retained.length, 0);
    assert.equal(result.warnings.length, 2);
    await assert.rejects(() => access(mismatched), { code: "ENOENT" });
    await assert.rejects(() => access(malformed), { code: "ENOENT" });
    await access(unrelated);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claimed scan unlinks a strict-name symlink without following its target", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-claimed-link-"));
  const outside = await mkdtemp(join(tmpdir(), "cinba-update-claimed-outside-"));
  const id = "33333333-3333-4333-8333-333333333333";
  const target = join(outside, "keep.json");
  const claimed = join(root, "update-handoff", `claimed-${id}.json`);
  try {
    await mkdir(join(root, "update-handoff"));
    await writeFile(target, "keep");
    await symlink(outside, claimed, process.platform === "win32" ? "junction" : "dir");
    const result = await reapClaimedUpdateHandoffs(root, {
      now,
      currentLeaseToken: "44444444-4444-4444-8444-444444444444",
    });
    assert.deepEqual(result.removed, [id]);
    assert.equal(result.warnings.length, 1);
    await assert.rejects(() => access(claimed), { code: "ENOENT" });
    assert.equal(await readFile(target, "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("claimed scan recovers a symlinked handoff directory without following it", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-claimed-dir-link-"));
  const outside = await mkdtemp(join(tmpdir(), "cinba-update-claimed-dir-outside-"));
  const sentinel = join(outside, "keep.json");
  try {
    await writeFile(sentinel, "keep");
    await symlink(
      outside,
      join(root, "update-handoff"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = await reapClaimedUpdateHandoffs(root, {
      now,
      currentLeaseToken: "44444444-4444-4444-8444-444444444444",
    });
    assert.equal(result.warnings.length, 1);
    assert.equal(await readFile(sentinel, "utf8"), "keep");
    assert.equal((await lstat(join(root, "update-handoff"))).isDirectory(), true);
    assert.equal((await lstat(join(root, "update-handoff"))).isSymbolicLink(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
