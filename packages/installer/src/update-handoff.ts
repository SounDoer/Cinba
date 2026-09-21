import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { type UpdateCandidate, parseUpdateState, readUpdateState } from "./update-state.ts";

export const UPDATE_HANDOFF_TTL_MS = 5 * 60 * 1_000;

type UpdateSurface = "cli" | "desktop" | "tui";
type UpdateRestart = Record<string, never> | { workingDirectory: string };

export type UpdateHandoff = {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  surface: UpdateSurface;
  blockingProcessId: number;
  candidate: UpdateCandidate & { artifactPath: string };
  restart: UpdateRestart;
  leaseToken: string;
};

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID = new RegExp(`^${UUID_SOURCE}$`, "u");
const CLAIMED_HANDOFF_FILE = new RegExp(`^claimed-(${UUID_SOURCE})\\.json$`, "u");

function exactRecord(
  value: unknown,
  fields: readonly string[],
  context: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((field) => !fields.includes(field)) ||
    fields.some((field) => !Object.hasOwn(record, field))
  ) {
    throw new Error(`${context} fields are invalid`);
  }
  return record;
}

function parseCandidate(value: unknown): UpdateHandoff["candidate"] {
  const state = parseUpdateState({
    schemaVersion: 1,
    phase: "ready",
    currentVersion: "0.0.0",
    checkedAt: "1970-01-01T00:00:00.000Z",
    candidate: value,
    failure: null,
  });
  if (!state.candidate?.artifactPath) {
    throw new Error("update handoff candidate requires an artifact");
  }
  return { ...state.candidate, artifactPath: state.candidate.artifactPath };
}

export function parseUpdateHandoff(
  value: unknown,
  options: { now?: Date; ttlMs?: number; allowExpired?: boolean } = {},
): UpdateHandoff {
  const parsed = exactRecord(
    value,
    [
      "schemaVersion",
      "id",
      "createdAt",
      "surface",
      "blockingProcessId",
      "candidate",
      "restart",
      "leaseToken",
    ],
    "update handoff",
  );
  if (parsed.schemaVersion !== 1) {
    throw new Error("update handoff schemaVersion must be 1");
  }
  if (typeof parsed.id !== "string" || !UUID.test(parsed.id)) {
    throw new Error("update handoff id must be a UUID");
  }
  if (
    typeof parsed.createdAt !== "string" ||
    !parsed.createdAt.endsWith("Z") ||
    Number.isNaN(Date.parse(parsed.createdAt))
  ) {
    throw new Error("update handoff createdAt must be an ISO UTC timestamp");
  }
  const createdAt = Date.parse(parsed.createdAt);
  const now = (options.now ?? new Date()).getTime();
  if (createdAt > now) {
    throw new Error("update handoff createdAt is in the future");
  }
  if (!options.allowExpired && now - createdAt > (options.ttlMs ?? UPDATE_HANDOFF_TTL_MS)) {
    throw new Error("update handoff has expired");
  }
  if (parsed.surface !== "cli" && parsed.surface !== "desktop" && parsed.surface !== "tui") {
    throw new Error("update handoff surface is invalid");
  }
  if (!Number.isSafeInteger(parsed.blockingProcessId) || (parsed.blockingProcessId as number) < 1) {
    throw new Error("update handoff blockingProcessId must be a positive integer");
  }
  const restart =
    parsed.surface === "tui"
      ? exactRecord(parsed.restart, ["workingDirectory"], "tui restart")
      : exactRecord(parsed.restart, [], `${parsed.surface} restart`);
  if (
    parsed.surface === "tui" &&
    (typeof restart.workingDirectory !== "string" || !isAbsolute(restart.workingDirectory))
  ) {
    throw new Error("tui restart workingDirectory must be absolute");
  }
  if (typeof parsed.leaseToken !== "string" || !UUID.test(parsed.leaseToken)) {
    throw new Error("update handoff lease token is invalid");
  }
  return {
    schemaVersion: 1,
    id: parsed.id,
    createdAt: new Date(createdAt).toISOString(),
    surface: parsed.surface,
    blockingProcessId: parsed.blockingProcessId as number,
    candidate: parseCandidate(parsed.candidate),
    restart:
      parsed.surface === "tui" ? { workingDirectory: restart.workingDirectory as string } : {},
    leaseToken: parsed.leaseToken,
  };
}

export function createUpdateHandoff(options: {
  id?: string;
  createdAt?: Date;
  surface: UpdateSurface;
  blockingProcessId: number;
  candidate: UpdateCandidate;
  restart: UpdateRestart;
  leaseToken: string;
}): UpdateHandoff {
  return parseUpdateHandoff(
    {
      schemaVersion: 1,
      id: options.id ?? randomUUID(),
      createdAt: (options.createdAt ?? new Date()).toISOString(),
      surface: options.surface,
      blockingProcessId: options.blockingProcessId,
      candidate: options.candidate,
      restart: options.restart,
      leaseToken: options.leaseToken,
    },
    { now: options.createdAt ?? new Date() },
  );
}

function handoffDirectory(stateDirectory: string): string {
  if (!isAbsolute(stateDirectory)) {
    throw new Error("update handoff stateDirectory must be absolute");
  }
  return join(stateDirectory, "update-handoff");
}

export function updateHandoffPath(stateDirectory: string): string {
  return join(handoffDirectory(stateDirectory), "handoff.json");
}

async function rejectSymbolicLink(path: string, description: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`${description} must not be a symbolic link`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function ensureStorageDirectory(stateDirectory: string): Promise<string> {
  const directory = handoffDirectory(stateDirectory);
  await mkdir(dirname(directory), { recursive: true });
  await rejectSymbolicLink(directory, "update handoff directory");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const status = await lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("update handoff directory is not a private directory");
  }
  return directory;
}

export async function writeUpdateHandoff(
  stateDirectory: string,
  handoff: UpdateHandoff,
  options: { now?: Date } = {},
): Promise<void> {
  const parsed = parseUpdateHandoff(handoff, options);
  const directory = await ensureStorageDirectory(stateDirectory);
  const path = updateHandoffPath(stateDirectory);
  await rejectSymbolicLink(path, "update handoff file");
  try {
    await lstat(join(directory, `claimed-${parsed.id}.json`));
    throw new Error("a claimed update handoff with the same id already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const temporary = join(directory, `.handoff-${parsed.id}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("an update handoff already exists", { cause: error });
    }
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function claimUpdateHandoff(
  stateDirectory: string,
  options: { now?: Date } = {},
): Promise<{ handoff: UpdateHandoff; claimedPath: string }> {
  const directory = await ensureStorageDirectory(stateDirectory);
  const path = updateHandoffPath(stateDirectory);
  await rejectSymbolicLink(path, "update handoff file");
  let handoff: UpdateHandoff;
  try {
    handoff = parseUpdateHandoff(JSON.parse(await readFile(path, "utf8")) as unknown, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("update handoff does not exist", { cause: error });
    }
    throw error;
  }
  const claimedPath = join(directory, `claimed-${handoff.id}.json`);
  try {
    await link(path, claimedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("update handoff was already claimed", { cause: error });
    }
    throw error;
  }
  await rm(path);
  return { handoff, claimedPath };
}

async function removeMatchingHandoffRecord(path: string, id: string, now?: Date): Promise<void> {
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink()) {
      throw new Error("update handoff record must not be a symbolic link");
    }
    if (!status.isFile()) {
      throw new Error("update handoff record must be a regular file");
    }
    const handoff = parseUpdateHandoff(JSON.parse(await readFile(path, "utf8")) as unknown, {
      ...(now ? { now } : {}),
      allowExpired: true,
    });
    if (handoff.id === id) {
      await unlink(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function removeUpdateHandoff(
  stateDirectory: string,
  id: string,
  options: { now?: Date } = {},
): Promise<void> {
  if (!UUID.test(id)) {
    throw new Error("update handoff id must be a UUID");
  }
  await ensureStorageDirectory(stateDirectory);
  await removeMatchingHandoffRecord(updateHandoffPath(stateDirectory), id, options.now);
  await removeMatchingHandoffRecord(
    join(handoffDirectory(stateDirectory), `claimed-${id}.json`),
    id,
    options.now,
  );
}

export type ClaimedUpdateHandoffReapResult = {
  removed: string[];
  retained: string[];
  warnings: string[];
};

export async function reapClaimedUpdateHandoffs(
  stateDirectory: string,
  options: { currentLeaseToken: string; now?: Date },
): Promise<ClaimedUpdateHandoffReapResult> {
  if (!UUID.test(options.currentLeaseToken)) {
    throw new Error("current update lease token is invalid");
  }
  const result: ClaimedUpdateHandoffReapResult = {
    removed: [],
    retained: [],
    warnings: [],
  };
  const requestedDirectory = handoffDirectory(stateDirectory);
  try {
    const status = await lstat(requestedDirectory);
    if (status.isSymbolicLink()) {
      await unlink(requestedDirectory);
      result.warnings.push("removed symbolic-link update handoff directory");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const directory = await ensureStorageDirectory(stateDirectory);
  const now = options.now ?? new Date();
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const match = CLAIMED_HANDOFF_FILE.exec(entry.name);
    if (!match) {
      continue;
    }
    const id = match[1]!;
    const path = join(directory, entry.name);
    const status = await lstat(path);
    if (status.isSymbolicLink()) {
      await unlink(path);
      result.removed.push(id);
      result.warnings.push(`removed symbolic-link claimed update handoff ${entry.name}`);
      continue;
    }
    if (!status.isFile()) {
      result.warnings.push(`retained non-regular claimed update handoff ${entry.name}`);
      continue;
    }
    let handoff: UpdateHandoff;
    try {
      handoff = parseUpdateHandoff(JSON.parse(await readFile(path, "utf8")) as unknown, {
        now,
        allowExpired: true,
      });
    } catch {
      await unlink(path);
      result.removed.push(id);
      result.warnings.push(`removed invalid claimed update handoff ${entry.name}`);
      continue;
    }
    if (handoff.id !== id) {
      await unlink(path);
      result.removed.push(id);
      result.warnings.push(`removed mismatched claimed update handoff ${entry.name}`);
      continue;
    }
    if (now.getTime() - Date.parse(handoff.createdAt) > UPDATE_HANDOFF_TTL_MS) {
      await unlink(path);
      result.removed.push(id);
    } else {
      result.retained.push(id);
    }
  }
  return result;
}

export async function writeUpdateHandoffRecoveringStale(
  stateDirectory: string,
  handoff: UpdateHandoff,
  options: { currentLeaseToken: string; now?: Date },
): Promise<void> {
  if (!UUID.test(options.currentLeaseToken)) {
    throw new Error("current update lease token is invalid");
  }
  const directory = handoffDirectory(stateDirectory);
  try {
    const status = await lstat(directory);
    if (status.isSymbolicLink()) {
      await unlink(directory);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  try {
    await writeUpdateHandoff(stateDirectory, handoff, { now: options.now });
    return;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      (error.message !== "an update handoff already exists" &&
        !error.message.includes("must not be a symbolic link"))
    ) {
      throw error;
    }
  }

  const path = updateHandoffPath(stateDirectory);
  const status = await lstat(path);
  if (status.isSymbolicLink()) {
    await unlink(path);
    await writeUpdateHandoff(stateDirectory, handoff, { now: options.now });
    return;
  }
  if (!status.isFile()) {
    throw new Error("existing update handoff is not a regular file");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    raw = undefined;
  }
  try {
    parseUpdateHandoff(raw, { now: options.now });
    throw new Error("an active update handoff already exists");
  } catch (error) {
    if (error instanceof Error && error.message === "an active update handoff already exists") {
      throw error;
    }
  }
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>).leaseToken === options.currentLeaseToken
  ) {
    throw new Error("invalid update handoff belongs to the current update lease");
  }

  let stale: UpdateHandoff | undefined;
  try {
    stale = parseUpdateHandoff(raw, { now: options.now, allowExpired: true });
  } catch {
    // A malformed ordinary file is recoverable only because this caller owns the update lease.
  }
  if (stale) {
    await removeUpdateHandoff(stateDirectory, stale.id, { now: options.now });
  } else {
    await unlink(path);
  }
  await writeUpdateHandoff(stateDirectory, handoff, { now: options.now });
}

export async function assertUpdateHandoffMatchesReadyState(
  stateDirectory: string,
  handoff: UpdateHandoff,
): Promise<void> {
  const state = await readUpdateState(stateDirectory);
  const candidate = state?.candidate;
  if (
    state?.phase !== "ready" ||
    !candidate ||
    candidate.version !== handoff.candidate.version ||
    candidate.revision !== handoff.candidate.revision ||
    candidate.target !== handoff.candidate.target ||
    candidate.artifactPath !== handoff.candidate.artifactPath ||
    candidate.size !== handoff.candidate.size ||
    candidate.sha256 !== handoff.candidate.sha256 ||
    candidate.releaseUrl !== handoff.candidate.releaseUrl
  ) {
    throw new Error("update handoff candidate does not match the ready update");
  }
}
