import { rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const REVISION = /^[0-9a-f]{40}$/;

export async function cleanupUpdateCandidateCache(options: {
  cacheDirectory: string;
  revision: string;
  artifactPath: string | null;
}): Promise<void> {
  if (!isAbsolute(options.cacheDirectory)) {
    throw new Error("update cacheDirectory must be absolute");
  }
  if (!REVISION.test(options.revision)) {
    throw new Error("update candidate revision is invalid");
  }
  const cache = resolve(options.cacheDirectory);
  if (dirname(cache) === cache) {
    throw new Error("update cacheDirectory cannot be a filesystem root");
  }
  const candidateDirectory = resolve(cache, "updates", options.revision);
  if (
    options.artifactPath !== null &&
    dirname(resolve(options.artifactPath)) !== candidateDirectory
  ) {
    throw new Error("update artifact is outside its revision cache directory");
  }
  await rm(candidateDirectory, { recursive: true, force: true });
}
