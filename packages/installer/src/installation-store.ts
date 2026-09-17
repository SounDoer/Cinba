import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ProductTarget, isProductTarget } from "./platform.ts";

export type InstalledRelease = {
  version: string;
  revision: string;
  protocolVersion: number;
  dataFormatVersion: number;
  target: ProductTarget;
  directory: string;
};

export type CurrentReleasePointer = {
  schemaVersion: 1;
  release: InstalledRelease;
};

export type InstallationPhase =
  | "staging"
  | "ready"
  | "switching"
  | "verifying"
  | "committed"
  | "rolling-back"
  | "rolled-back"
  | "failed";

export type InstallationFailure =
  | "candidate-invalid"
  | "stage-failed"
  | "switch-failed"
  | "verification-failed"
  | "rollback-failed"
  | "interrupted";

export type InstallationTransaction = {
  schemaVersion: 1;
  id: string;
  phase: InstallationPhase;
  candidate: InstalledRelease;
  previous: InstalledRelease | null;
  startedAt: string;
  updatedAt: string;
  failure: InstallationFailure | null;
};

export type InstallationLayout = {
  programDirectory: string;
  releasesDirectory: string;
  transactionDirectory: string;
};

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const REVISION = /^[0-9a-f]{40}$/;
const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RELEASE_DIRECTORY = /^[0-9a-f]{40}$/;
const CANDIDATE_DIRECTORY = /^\.[0-9a-f]{40}\.[0-9a-f-]{36}\.candidate$/;
const PHASES = new Set<InstallationPhase>([
  "staging",
  "ready",
  "switching",
  "verifying",
  "committed",
  "rolling-back",
  "rolled-back",
  "failed",
]);
const FAILURES = new Set<InstallationFailure>([
  "candidate-invalid",
  "stage-failed",
  "switch-failed",
  "verification-failed",
  "rollback-failed",
  "interrupted",
]);

function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
): void {
  const unknown = Object.keys(value).find((key) => !expected.includes(key));
  if (unknown) {
    throw new Error(`${context} contains unknown field ${unknown}`);
  }
  const missing = expected.find((key) => !Object.hasOwn(value, key));
  if (missing) {
    throw new Error(`${context} is missing field ${missing}`);
  }
}

function timestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`${field} must be an ISO UTC timestamp`);
  }
  return value;
}

function parseInstalledRelease(value: unknown, allowCandidate: boolean): InstalledRelease {
  const parsed = object(value, "installed release");
  exactKeys(
    parsed,
    ["version", "revision", "protocolVersion", "dataFormatVersion", "target", "directory"],
    "installed release",
  );
  if (typeof parsed.version !== "string" || !SEMVER.test(parsed.version)) {
    throw new Error("installed release version must be SemVer");
  }
  if (typeof parsed.revision !== "string" || !REVISION.test(parsed.revision)) {
    throw new Error("installed release revision must be a full lowercase Git commit");
  }
  if (!Number.isSafeInteger(parsed.protocolVersion) || (parsed.protocolVersion as number) < 1) {
    throw new Error("installed release protocolVersion must be a positive integer");
  }
  if (!Number.isSafeInteger(parsed.dataFormatVersion) || (parsed.dataFormatVersion as number) < 1) {
    throw new Error("installed release dataFormatVersion must be a positive integer");
  }
  if (!isProductTarget(parsed.target)) {
    throw new Error("installed release target is not supported");
  }
  if (
    typeof parsed.directory !== "string" ||
    !(allowCandidate ? CANDIDATE_DIRECTORY : RELEASE_DIRECTORY).test(parsed.directory)
  ) {
    throw new Error("installed release directory is not a safe direct child");
  }
  return {
    version: parsed.version,
    revision: parsed.revision,
    protocolVersion: parsed.protocolVersion as number,
    dataFormatVersion: parsed.dataFormatVersion as number,
    target: parsed.target,
    directory: parsed.directory,
  };
}

export function parseCurrentReleasePointer(value: unknown): CurrentReleasePointer {
  const parsed = object(value, "current release pointer");
  exactKeys(parsed, ["schemaVersion", "release"], "current release pointer");
  if (parsed.schemaVersion !== 1) {
    throw new Error("current release pointer schemaVersion must be 1");
  }
  return { schemaVersion: 1, release: parseInstalledRelease(parsed.release, false) };
}

export function parseInstallationTransaction(value: unknown): InstallationTransaction {
  const parsed = object(value, "installation transaction");
  exactKeys(
    parsed,
    ["schemaVersion", "id", "phase", "candidate", "previous", "startedAt", "updatedAt", "failure"],
    "installation transaction",
  );
  if (parsed.schemaVersion !== 1) {
    throw new Error("installation transaction schemaVersion must be 1");
  }
  if (typeof parsed.id !== "string" || !TRANSACTION_ID.test(parsed.id)) {
    throw new Error("installation transaction id must be a UUID");
  }
  if (typeof parsed.phase !== "string" || !PHASES.has(parsed.phase as InstallationPhase)) {
    throw new Error("installation transaction phase is not supported");
  }
  if (
    parsed.failure !== null &&
    (typeof parsed.failure !== "string" || !FAILURES.has(parsed.failure as InstallationFailure))
  ) {
    throw new Error("installation transaction failure is not supported");
  }
  return {
    schemaVersion: 1,
    id: parsed.id,
    phase: parsed.phase as InstallationPhase,
    candidate: parseInstalledRelease(parsed.candidate, true),
    previous: parsed.previous === null ? null : parseInstalledRelease(parsed.previous, false),
    startedAt: timestamp(parsed.startedAt, "installation transaction startedAt"),
    updatedAt: timestamp(parsed.updatedAt, "installation transaction updatedAt"),
    failure: parsed.failure as InstallationFailure | null,
  };
}

function requireAbsoluteLayout(layout: InstallationLayout): void {
  for (const [name, value] of Object.entries(layout)) {
    if (!isAbsolute(value)) {
      throw new Error(`${name} must be an absolute path`);
    }
  }
  const releases = resolve(layout.releasesDirectory);
  const program = resolve(layout.programDirectory);
  const path = relative(program, releases);
  if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error("releasesDirectory must be inside programDirectory");
  }
}

export function currentPointerPath(layout: InstallationLayout): string {
  requireAbsoluteLayout(layout);
  return join(resolve(layout.programDirectory), "current.json");
}

export function transactionStatePath(layout: InstallationLayout): string {
  requireAbsoluteLayout(layout);
  return join(resolve(layout.transactionDirectory), "transaction.json");
}

export function releasePath(layout: InstallationLayout, release: InstalledRelease): string {
  requireAbsoluteLayout(layout);
  const parsed = parseInstalledRelease(release, release.directory.startsWith("."));
  return join(resolve(layout.releasesDirectory), parsed.directory);
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readCurrentRelease(
  layout: InstallationLayout,
): Promise<InstalledRelease | undefined> {
  const value = await readJson(currentPointerPath(layout));
  return value === undefined ? undefined : parseCurrentReleasePointer(value).release;
}

export async function writeCurrentRelease(
  layout: InstallationLayout,
  release: InstalledRelease,
): Promise<void> {
  await writeAtomic(currentPointerPath(layout), {
    schemaVersion: 1,
    release: parseInstalledRelease(release, false),
  } satisfies CurrentReleasePointer);
}

export async function clearCurrentRelease(layout: InstallationLayout): Promise<void> {
  await rm(currentPointerPath(layout), { force: true });
}

export async function readInstallationTransaction(
  layout: InstallationLayout,
): Promise<InstallationTransaction | undefined> {
  const value = await readJson(transactionStatePath(layout));
  return value === undefined ? undefined : parseInstallationTransaction(value);
}

export async function writeInstallationTransaction(
  layout: InstallationLayout,
  transaction: InstallationTransaction,
): Promise<void> {
  await writeAtomic(transactionStatePath(layout), parseInstallationTransaction(transaction));
}
