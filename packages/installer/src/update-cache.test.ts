import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import { cleanupUpdateCandidateCache } from "./update-cache.ts";

test("candidate cache cleanup removes only its revision directory", async (t) => {
  const root = temporaryDirectory("cinba-update-cache-cleanup-", t);
  const cache = join(root, "cache");
  const revision = "a".repeat(40);
  const otherRevision = "b".repeat(40);
  const candidateDirectory = join(cache, "updates", revision);
  const artifactPath = join(candidateDirectory, "Cinba.exe");
  await mkdir(candidateDirectory, { recursive: true });
  await mkdir(join(cache, "updates", otherRevision), { recursive: true });
  await writeFile(artifactPath, "candidate");
  await writeFile(join(cache, "updates", otherRevision, "Cinba.exe"), "other");
  await cleanupUpdateCandidateCache({ cacheDirectory: cache, revision, artifactPath });
  assert.deepEqual(await readdir(join(cache, "updates")), [otherRevision]);
});

test("candidate cache cleanup rejects paths outside cache updates", async (t) => {
  const root = temporaryDirectory("cinba-update-cache-boundary-", t);
  const cache = join(root, "cache");
  const outside = join(root, "keep.txt");
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
});
