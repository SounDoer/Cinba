import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type DownloadedUpdate, downloadUpdateCandidate } from "./update-download.ts";
import { type UpdateDiscovery, discoverCinbaUpdate } from "./update-discovery.ts";
import type { ProductTarget } from "./platform.ts";
import {
  type UpdateCandidate,
  type UpdateFailure,
  type UpdateState,
  writeUpdateState,
} from "./update-state.ts";

type UpdateLock = { schemaVersion: 1; pid: number; token: string };

async function readLock(path: string): Promise<UpdateLock | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<UpdateLock>;
    return parsed.schemaVersion === 1 &&
      Number.isSafeInteger(parsed.pid) &&
      (parsed.pid ?? 0) > 0 &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0
      ? (parsed as UpdateLock)
      : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function acquireUpdateLock(
  stateDirectory: string,
  processId: number,
): Promise<() => Promise<void>> {
  const path = join(stateDirectory, "update-operation");
  const ownerPath = join(path, "owner.json");
  const token = randomUUID();
  await mkdir(stateDirectory, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(path);
      await writeFile(
        ownerPath,
        JSON.stringify({ schemaVersion: 1, pid: processId, token } satisfies UpdateLock),
        { flag: "wx", mode: 0o600 },
      );
      return async () => {
        if ((await readLock(ownerPath))?.token === token) {
          await rm(path, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const owner = await readLock(ownerPath);
      if (!owner || processIsAlive(owner.pid)) {
        throw new Error("another Cinba update operation is active", { cause: error });
      }
      await rm(path, { recursive: true, force: true });
    }
  }
  throw new Error("could not acquire the Cinba update operation lock");
}

function candidateFrom(update: Extract<UpdateDiscovery, { state: "available" }>): UpdateCandidate {
  return {
    version: update.latestVersion,
    revision: update.manifest.revision,
    target: update.artifact.target,
    artifactPath: null,
    size: update.artifact.size,
    sha256: update.artifact.sha256,
    releaseUrl: update.releaseUrl,
  };
}

function state(
  phase: UpdateState["phase"],
  currentVersion: string,
  checkedAt: string,
  candidate: UpdateCandidate | null,
  failure: UpdateFailure | null = null,
): UpdateState {
  return { schemaVersion: 1, phase, currentVersion, checkedAt, candidate, failure };
}

export async function prepareProductUpdate(options: {
  currentVersion: string;
  currentRevision: string;
  target: ProductTarget;
  stateDirectory: string;
  cacheDirectory: string;
  fetch?: typeof fetch;
  now?: () => Date;
  processId?: number;
  signal?: AbortSignal;
  discover?: typeof discoverCinbaUpdate;
  download?: typeof downloadUpdateCandidate;
}): Promise<UpdateState> {
  const release = await acquireUpdateLock(options.stateDirectory, options.processId ?? process.pid);
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  let candidate: UpdateCandidate | null = null;
  let operation: "discovery" | "download" = "discovery";
  try {
    await writeUpdateState(
      options.stateDirectory,
      state("checking", options.currentVersion, checkedAt, null),
    );
    const update = await (options.discover ?? discoverCinbaUpdate)({
      currentVersion: options.currentVersion,
      currentRevision: options.currentRevision,
      target: options.target,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    if (update.state === "current") {
      const current = state("current", options.currentVersion, checkedAt, null);
      await writeUpdateState(options.stateDirectory, current);
      return current;
    }
    operation = "download";
    candidate = candidateFrom(update);
    await writeUpdateState(
      options.stateDirectory,
      state("downloading", options.currentVersion, checkedAt, candidate),
    );
    const downloaded: DownloadedUpdate = await (options.download ?? downloadUpdateCandidate)({
      update,
      cacheDirectory: options.cacheDirectory,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    candidate = { ...candidate, artifactPath: downloaded.artifactPath };
    const ready = state("ready", options.currentVersion, checkedAt, candidate);
    await writeUpdateState(options.stateDirectory, ready);
    return ready;
  } catch (error) {
    const failure = operation === "discovery" ? "discovery-failed" : "download-failed";
    await writeUpdateState(
      options.stateDirectory,
      state("failed", options.currentVersion, checkedAt, candidate, failure),
    );
    throw error;
  } finally {
    await release();
  }
}
