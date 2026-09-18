import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { UpdateDiscovery } from "./update-discovery.ts";

export type DownloadedUpdate = {
  version: string;
  revision: string;
  target: string;
  artifactPath: string;
  size: number;
  sha256: string;
  reused: boolean;
};

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function validCachedArtifact(
  path: string,
  expected: { size: number; sha256: string },
): Promise<boolean> {
  try {
    const status = await stat(path);
    return (
      status.isFile() &&
      status.size === expected.size &&
      (await fileSha256(path)) === expected.sha256
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function requireCacheDirectory(path: string): string {
  if (!isAbsolute(path)) {
    throw new Error("update cacheDirectory must be absolute");
  }
  const normalized = resolve(path);
  if (dirname(normalized) === normalized) {
    throw new Error("update cacheDirectory cannot be a filesystem root");
  }
  return normalized;
}

async function writeResponse(
  response: Response,
  path: string,
  expectedSize: number,
): Promise<{ size: number; sha256: string }> {
  if (!response.ok) {
    throw new Error(`update download failed with HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("update download response has no body");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) !== expectedSize) {
    throw new Error("update download Content-Length does not match the manifest");
  }
  const file = await open(path, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      size += result.value.byteLength;
      if (size > expectedSize) {
        await reader.cancel("artifact exceeds manifest size");
        throw new Error("update download exceeds the manifest size");
      }
      hash.update(result.value);
      await file.write(result.value);
    }
  } finally {
    await file.close();
  }
  return { size, sha256: hash.digest("hex") };
}

export async function downloadUpdateCandidate(options: {
  update: Extract<UpdateDiscovery, { state: "available" }>;
  cacheDirectory: string;
  fetch?: typeof fetch;
}): Promise<DownloadedUpdate> {
  const cache = requireCacheDirectory(options.cacheDirectory);
  const { update } = options;
  const directory = join(cache, "updates", update.manifest.revision);
  const artifactPath = join(directory, update.artifact.fileName);
  const expected = { size: update.artifact.size, sha256: update.artifact.sha256 };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await validCachedArtifact(artifactPath, expected)) {
    return {
      version: update.manifest.version,
      revision: update.manifest.revision,
      target: update.artifact.target,
      artifactPath,
      ...expected,
      reused: true,
    };
  }
  await rm(artifactPath, { force: true });
  const temporary = `${artifactPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const response = await (options.fetch ?? fetch)(update.downloadUrl, {
      headers: { "User-Agent": `Cinba/${update.currentVersion}` },
      redirect: "follow",
    });
    const actual = await writeResponse(response, temporary, expected.size);
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
      throw new Error("update download does not match the release manifest");
    }
    await rename(temporary, artifactPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return {
    version: update.manifest.version,
    revision: update.manifest.revision,
    target: update.artifact.target,
    artifactPath,
    ...expected,
    reused: false,
  };
}
