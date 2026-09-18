import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupUpdateCandidateCache } from "./update-cache.ts";

test("candidate cache cleanup removes only its revision directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-cache-cleanup-"));
  const cache = join(root, "cache");
  const revision = "a".repeat(40);
  const otherRevision = "b".repeat(40);
  const candidateDirectory = join(cache, "updates", revision);
  const artifactPath = join(candidateDirectory, "Cinba.exe");
  try {
    await mkdir(candidateDirectory, { recursive: true });
    await mkdir(join(cache, "updates", otherRevision), { recursive: true });
    await writeFile(artifactPath, "candidate");
    await writeFile(join(cache, "updates", otherRevision, "Cinba.exe"), "other");
    await cleanupUpdateCandidateCache({ cacheDirectory: cache, revision, artifactPath });
    assert.deepEqual(await readdir(join(cache, "updates")), [otherRevision]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate cache cleanup rejects paths outside cache updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-cache-boundary-"));
  const cache = join(root, "cache");
  const outside = join(root, "keep.txt");
  try {
    await mkdir(cache);
    await writeFile(outside, "keep");
    await assert.rejects(
      cleanupUpdateCandidateCache({
        cacheDirectory: cache,
        revision: "a".repeat(40),
        artifactPath: outside,
      }),
      /outside its revision cache directory/,
    );
    await assert.rejects(
      cleanupUpdateCandidateCache({
        cacheDirectory: cache,
        revision: "../outside",
        artifactPath: outside,
      }),
      /revision is invalid/,
    );
    assert.equal(await readFile(outside, "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
