import { createHash } from "node:crypto";
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
  existingSize: number,
): Promise<number> {
  if (!response.ok) {
    throw new Error(`update download failed with HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("update download response has no body");
  }
  const resumed = existingSize > 0 && response.status === 206;
  const offset = resumed ? existingSize : 0;
  if (response.status === 206) {
    const contentRange = response.headers.get("content-range");
    const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (
      !match ||
      Number(match[1]) !== existingSize ||
      Number(match[3]) !== expectedSize ||
      Number(match[2]) < Number(match[1])
    ) {
      throw new Error("update download Content-Range does not match the partial artifact");
    }
  }
  const expectedResponseSize = expectedSize - offset;
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) !== expectedResponseSize) {
    throw new Error("update download Content-Length does not match the manifest");
  }
  const file = await open(path, resumed ? "a" : "w", 0o600);
  let size = offset;
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
      await file.write(result.value);
    }
  } finally {
    await file.close();
  }
  return size;
}

async function partialSize(path: string, expectedSize: number): Promise<number> {
  try {
    const status = await stat(path);
    if (!status.isFile() || status.size >= expectedSize) {
      await rm(path, { force: true });
      return 0;
    }
    return status.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

export async function downloadUpdateCandidate(options: {
  update: Extract<UpdateDiscovery, { state: "available" }>;
  cacheDirectory: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
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
  const partialPath = `${artifactPath}.partial`;
  const existingSize = await partialSize(partialPath, expected.size);
  const response = await (options.fetch ?? fetch)(update.downloadUrl, {
    headers: {
      "User-Agent": `Cinba/${update.currentVersion}`,
      ...(existingSize > 0 ? { Range: `bytes=${existingSize}-` } : {}),
    },
    redirect: "follow",
    signal: options.signal,
  });
  const size = await writeResponse(response, partialPath, expected.size, existingSize);
  const sha256 = size === expected.size ? await fileSha256(partialPath) : "";
  if (size !== expected.size || sha256 !== expected.sha256) {
    if (size >= expected.size) {
      await rm(partialPath, { force: true });
    }
    throw new Error("update download does not match the release manifest");
  }
  await rename(partialPath, artifactPath);
  return {
    version: update.manifest.version,
    revision: update.manifest.revision,
    target: update.artifact.target,
    artifactPath,
    ...expected,
    reused: false,
  };
}
