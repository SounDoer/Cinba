import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireStartLock } from "./start-lock.ts";

test("a start lock stays exclusive until its owner releases it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cinba-lock-"));
  const path = join(directory, "start.lock");
  try {
    const releaseFirst = await acquireStartLock(path);
    let acquiredSecond = false;
    const second = acquireStartLock(path, { retryMs: 1 }).then((release) => {
      acquiredSecond = true;
      return release;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(acquiredSecond, false);
    releaseFirst();

    const releaseSecond = await second;
    assert.equal(acquiredSecond, true);
    releaseSecond();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a lock whose process has exited is replaced", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cinba-lock-"));
  const path = join(directory, "start.lock");
  try {
    writeFileSync(path, JSON.stringify({ pid: 1234, token: "stale" }));
    const release = await acquireStartLock(path, {
      processId: 5678,
      isProcessAlive: () => false,
    });

    assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 5678);
    release();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unreadable existing lock is preserved for inspection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cinba-lock-"));
  const path = join(directory, "start.lock");
  try {
    writeFileSync(path, "not json");
    await assert.rejects(acquireStartLock(path, { timeoutMs: 5, retryMs: 1 }), {
      message: `Core start lock is unreadable: ${path}`,
    });
    assert.equal(readFileSync(path, "utf8"), "not json");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
