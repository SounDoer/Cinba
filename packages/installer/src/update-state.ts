import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { type ProductTarget, isProductTarget } from "./platform.ts";

export type UpdatePhase = "current" | "checking" | "downloading" | "ready" | "failed";
export type UpdateFailure = "discovery-failed" | "download-failed" | "installation-failed";
export type UpdateCandidate = {
  version: string;
  revision: string;
  target: ProductTarget;
  artifactPath: string | null;
  size: number;
  sha256: string;
  releaseUrl: string;
};
export type UpdateState = {
  schemaVersion: 1;
  phase: UpdatePhase;
  currentVersion: string;
  checkedAt: string;
  candidate: UpdateCandidate | null;
  failure: UpdateFailure | null;
};

export const AUTOMATIC_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REVISION = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PHASES = new Set<UpdatePhase>(["current", "checking", "downloading", "ready", "failed"]);
const FAILURES = new Set<UpdateFailure>([
  "discovery-failed",
  "download-failed",
  "installation-failed",
]);

function exactRecord(
  value: unknown,
  fields: readonly string[],
  context: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  const parsed = value as Record<string, unknown>;
  if (
    Object.keys(parsed).some((field) => !fields.includes(field)) ||
    fields.some((field) => !Object.hasOwn(parsed, field))
  ) {
    throw new Error(`${context} fields are invalid`);
  }
  return parsed;
}

function parseCandidate(value: unknown): UpdateCandidate {
  const parsed = exactRecord(
    value,
    ["version", "revision", "target", "artifactPath", "size", "sha256", "releaseUrl"],
    "update candidate",
  );
  if (typeof parsed.version !== "string" || !SEMVER.test(parsed.version)) {
    throw new Error("update candidate version must be a stable SemVer");
  }
  if (typeof parsed.revision !== "string" || !REVISION.test(parsed.revision)) {
    throw new Error("update candidate revision must be a full lowercase Git commit");
  }
  if (!isProductTarget(parsed.target)) {
    throw new Error("update candidate target is not supported");
  }
  if (
    parsed.artifactPath !== null &&
    (typeof parsed.artifactPath !== "string" || !isAbsolute(parsed.artifactPath))
  ) {
    throw new Error("update candidate artifactPath must be absolute or null");
  }
  if (!Number.isSafeInteger(parsed.size) || (parsed.size as number) < 1) {
    throw new Error("update candidate size must be a positive integer");
  }
  if (typeof parsed.sha256 !== "string" || !SHA256.test(parsed.sha256)) {
    throw new Error("update candidate sha256 must be a lowercase SHA-256 digest");
  }
  if (typeof parsed.releaseUrl !== "string") {
    throw new Error("update candidate releaseUrl must be a string");
  }
  const releaseUrl = new URL(parsed.releaseUrl);
  if (releaseUrl.protocol !== "https:" || releaseUrl.hostname !== "github.com") {
    throw new Error("update candidate releaseUrl must be a GitHub HTTPS URL");
  }
  return {
    version: parsed.version,
    revision: parsed.revision,
    target: parsed.target,
    artifactPath: parsed.artifactPath as string | null,
    size: parsed.size as number,
    sha256: parsed.sha256,
    releaseUrl: releaseUrl.toString(),
  };
}

export function parseUpdateState(value: unknown): UpdateState {
  const parsed = exactRecord(
    value,
    ["schemaVersion", "phase", "currentVersion", "checkedAt", "candidate", "failure"],
    "update state",
  );
  if (parsed.schemaVersion !== 1) {
    throw new Error("update state schemaVersion must be 1");
  }
  if (typeof parsed.phase !== "string" || !PHASES.has(parsed.phase as UpdatePhase)) {
    throw new Error("update state phase is invalid");
  }
  if (typeof parsed.currentVersion !== "string" || !SEMVER.test(parsed.currentVersion)) {
    throw new Error("update state currentVersion must be a stable SemVer");
  }
  if (
    typeof parsed.checkedAt !== "string" ||
    !parsed.checkedAt.endsWith("Z") ||
    Number.isNaN(Date.parse(parsed.checkedAt))
  ) {
    throw new Error("update state checkedAt must be an ISO UTC timestamp");
  }
  if (
    parsed.failure !== null &&
    (typeof parsed.failure !== "string" || !FAILURES.has(parsed.failure as UpdateFailure))
  ) {
    throw new Error("update state failure is invalid");
  }
  const candidate = parsed.candidate === null ? null : parseCandidate(parsed.candidate);
  const phase = parsed.phase as UpdatePhase;
  if ((phase === "downloading" || phase === "ready") && !candidate) {
    throw new Error(`${phase} update state requires a candidate`);
  }
  if (phase === "ready" && !candidate?.artifactPath) {
    throw new Error("ready update state requires a downloaded artifact");
  }
  if (phase === "failed" ? parsed.failure === null : parsed.failure !== null) {
    throw new Error("update state failure does not match its phase");
  }
  if (parsed.failure === "installation-failed" && !candidate?.artifactPath) {
    throw new Error("update installation failure requires a candidate");
  }
  return {
    schemaVersion: 1,
    phase,
    currentVersion: parsed.currentVersion,
    checkedAt: parsed.checkedAt,
    candidate,
    failure: parsed.failure as UpdateFailure | null,
  };
}

export function updateStatePath(stateDirectory: string): string {
  if (!isAbsolute(stateDirectory)) {
    throw new Error("update stateDirectory must be absolute");
  }
  return join(stateDirectory, "update.json");
}

export function automaticUpdateCheckIsDue(options: {
  state: UpdateState | undefined;
  currentVersion: string;
  now?: Date;
  intervalMs?: number;
}): boolean {
  const intervalMs = options.intervalMs ?? AUTOMATIC_UPDATE_CHECK_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error("automatic update check interval must be a positive integer");
  }
  const state = options.state;
  if (!state || state.currentVersion !== options.currentVersion) {
    return true;
  }
  if (state.phase === "checking" || state.phase === "downloading") {
    return true;
  }
  return (options.now ?? new Date()).getTime() - Date.parse(state.checkedAt) >= intervalMs;
}

export async function readUpdateState(stateDirectory: string): Promise<UpdateState | undefined> {
  try {
    return parseUpdateState(
      JSON.parse(await readFile(updateStatePath(stateDirectory), "utf8")) as unknown,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function writeUpdateState(stateDirectory: string, state: UpdateState): Promise<void> {
  const path = updateStatePath(stateDirectory);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(parseUpdateState(state), null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function recordUpdateInstallationResult(options: {
  stateDirectory: string;
  currentVersion: string;
  candidate: UpdateCandidate;
  result: "installed" | "failed";
  now?: () => Date;
}): Promise<void> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  await writeUpdateState(
    options.stateDirectory,
    options.result === "installed"
      ? {
          schemaVersion: 1,
          phase: "current",
          currentVersion: options.candidate.version,
          checkedAt,
          candidate: null,
          failure: null,
        }
      : {
          schemaVersion: 1,
          phase: "failed",
          currentVersion: options.currentVersion,
          checkedAt,
          candidate: options.candidate,
          failure: "installation-failed",
        },
  );
}
