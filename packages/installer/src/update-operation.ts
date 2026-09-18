import { resolve } from "node:path";
import { type DownloadedUpdate, downloadUpdateCandidate } from "./update-download.ts";
import { type UpdateDiscovery, discoverCinbaUpdate } from "./update-discovery.ts";
import type { ProductTarget } from "./platform.ts";
import { type ProductUpdateLease, acquireProductUpdateLease } from "./update-lock.ts";
import {
  AUTOMATIC_UPDATE_CHECK_INTERVAL_MS,
  type UpdateCandidate,
  type UpdateFailure,
  type UpdateState,
  automaticUpdateCheckIsDue,
  readUpdateState,
  writeUpdateState,
} from "./update-state.ts";

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
  automatic?: boolean;
  checkIntervalMs?: number;
  discover?: typeof discoverCinbaUpdate;
  download?: typeof downloadUpdateCandidate;
  lease?: ProductUpdateLease;
}): Promise<UpdateState> {
  if (options.lease && options.lease.stateDirectory !== resolve(options.stateDirectory)) {
    throw new Error("update lease does not belong to this state directory");
  }
  const lease =
    options.lease ??
    (await acquireProductUpdateLease(options.stateDirectory, {
      processId: options.processId ?? process.pid,
    }));
  const ownsLease = !options.lease;
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  let candidate: UpdateCandidate | null = null;
  let operation: "discovery" | "download" = "discovery";
  try {
    if (options.automatic) {
      const existing = await readUpdateState(options.stateDirectory);
      if (
        existing &&
        !automaticUpdateCheckIsDue({
          state: existing,
          currentVersion: options.currentVersion,
          now: new Date(checkedAt),
          intervalMs: options.checkIntervalMs ?? AUTOMATIC_UPDATE_CHECK_INTERVAL_MS,
        })
      ) {
        return existing;
      }
    }
    await writeUpdateState(
      options.stateDirectory,
      state("checking", options.currentVersion, checkedAt, null),
    );
    const update = await (options.discover ?? discoverCinbaUpdate)({
      currentVersion: options.currentVersion,
      currentRevision: options.currentRevision,
      target: options.target,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
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
    if (ownsLease) {
      await lease.release();
    }
  }
}
