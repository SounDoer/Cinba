import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupReleases } from "./release-cleanup.ts";

const CURRENT = "1234567890abcdef1234567890abcdef12345678";
const PREVIOUS = "abcdef1234567890abcdef1234567890abcdef12";
const OLD = "fedcba0987654321fedcba0987654321fedcba09";
const FAILED = "0000000000000000000000000000000000000000";
const ROOT = "/home/cinba/releases";

function fakes(actual = CURRENT) {
  const discarded: string[] = [];
  return {
    discarded,
    dependencies: {
      async readCurrent() {
        return actual;
      },
      async listEntries() {
        return [
          { name: CURRENT, isDirectory: true },
          { name: PREVIOUS, isDirectory: true },
          { name: OLD, isDirectory: true },
          { name: FAILED, isDirectory: true },
          { name: "notes", isDirectory: true },
          { name: "current-copy", isDirectory: false },
        ];
      },
      async discard(input: { revision: string }) {
        discarded.push(input.revision);
      },
    },
  };
}

test("cleanup keeps the current and previous successful releases", async () => {
  const fake = fakes();
  assert.deepEqual(
    await cleanupReleases(
      {
        repoPath: "/home/cinba/Cinba",
        releasesRoot: ROOT,
        currentLink: "/home/cinba/current",
        runningRevision: CURRENT,
        previousRevision: PREVIOUS,
      },
      fake.dependencies,
    ),
    [`${ROOT}/${FAILED}`, `${ROOT}/${OLD}`],
  );
  assert.deepEqual(fake.discarded, [FAILED, OLD]);
});

test("a disagreement about current refuses every deletion", async () => {
  const fake = fakes(PREVIOUS);
  await assert.rejects(
    cleanupReleases(
      {
        repoPath: "/home/cinba/Cinba",
        releasesRoot: ROOT,
        currentLink: "/home/cinba/current",
        runningRevision: CURRENT,
        previousRevision: PREVIOUS,
      },
      fake.dependencies,
    ),
    /cleanup refused/,
  );
  assert.deepEqual(fake.discarded, []);
});

test("all safe candidates are attempted before cleanup reports failures", async () => {
  const fake = fakes();
  fake.dependencies.discard = async (input: { revision: string }) => {
    fake.discarded.push(input.revision);
    if (input.revision === FAILED) {
      throw new Error("busy worktree");
    }
  };
  await assert.rejects(
    cleanupReleases(
      {
        repoPath: "/home/cinba/Cinba",
        releasesRoot: ROOT,
        currentLink: "/home/cinba/current",
        runningRevision: CURRENT,
        previousRevision: PREVIOUS,
      },
      fake.dependencies,
    ),
    /obsolete releases/,
  );
  assert.deepEqual(fake.discarded, [FAILED, OLD]);
});
