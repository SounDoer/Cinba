import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

export type ServiceComponent = "core" | "sync";
export type ServiceMode = "disabled" | "on-demand" | "background";
export type ServiceOperationPhase = "stable" | "applying" | "failed";
export type ServiceFailure =
  | "registration-failed"
  | "start-failed"
  | "health-failed"
  | "stop-failed"
  | "removal-failed"
  | "recovery-failed";

export type ServiceComponentRecord = {
  mode: ServiceMode | null;
  desiredMode: ServiceMode;
  phase: ServiceOperationPhase;
  updatedAt: string;
  failure: ServiceFailure | null;
};

export type ServiceState = {
  schemaVersion: 1;
  core: ServiceComponentRecord;
  sync: ServiceComponentRecord;
};

const MODES = new Set<ServiceMode>(["disabled", "on-demand", "background"]);
const PHASES = new Set<ServiceOperationPhase>(["stable", "applying", "failed"]);
const FAILURES = new Set<ServiceFailure>([
  "registration-failed",
  "start-failed",
  "health-failed",
  "stop-failed",
  "removal-failed",
  "recovery-failed",
]);

function exactObject(
  value: unknown,
  fields: readonly string[],
  context: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  const parsed = value as Record<string, unknown>;
  const unknown = Object.keys(parsed).find((key) => !fields.includes(key));
  const missing = fields.find((key) => !Object.hasOwn(parsed, key));
  if (unknown || missing) {
    throw new Error(`${context} fields are invalid`);
  }
  return parsed;
}

function parseRecord(value: unknown, component: ServiceComponent): ServiceComponentRecord {
  const parsed = exactObject(
    value,
    ["mode", "desiredMode", "phase", "updatedAt", "failure"],
    `${component} service state`,
  );
  if (
    parsed.mode !== null &&
    (typeof parsed.mode !== "string" || !MODES.has(parsed.mode as ServiceMode))
  ) {
    throw new Error(`${component} service mode is invalid`);
  }
  if (typeof parsed.desiredMode !== "string" || !MODES.has(parsed.desiredMode as ServiceMode)) {
    throw new Error(`${component} desired service mode is invalid`);
  }
  if (typeof parsed.phase !== "string" || !PHASES.has(parsed.phase as ServiceOperationPhase)) {
    throw new Error(`${component} service phase is invalid`);
  }
  if (
    parsed.failure !== null &&
    (typeof parsed.failure !== "string" || !FAILURES.has(parsed.failure as ServiceFailure))
  ) {
    throw new Error(`${component} service failure is invalid`);
  }
  if (
    typeof parsed.updatedAt !== "string" ||
    !parsed.updatedAt.endsWith("Z") ||
    Number.isNaN(Date.parse(parsed.updatedAt))
  ) {
    throw new Error(`${component} service updatedAt must be an ISO UTC timestamp`);
  }
  if (
    parsed.phase === "stable" &&
    (parsed.mode !== parsed.desiredMode || parsed.failure !== null)
  ) {
    throw new Error(`${component} stable service state is inconsistent`);
  }
  if (parsed.phase === "applying" && parsed.failure !== null) {
    throw new Error(`${component} applying service state cannot contain a failure`);
  }
  if (parsed.phase === "failed" && parsed.failure === null) {
    throw new Error(`${component} failed service state requires a failure`);
  }
  return {
    mode: parsed.mode as ServiceMode | null,
    desiredMode: parsed.desiredMode as ServiceMode,
    phase: parsed.phase as ServiceOperationPhase,
    updatedAt: parsed.updatedAt,
    failure: parsed.failure as ServiceFailure | null,
  };
}

export function parseServiceState(value: unknown): ServiceState {
  const parsed = exactObject(value, ["schemaVersion", "core", "sync"], "service state");
  if (parsed.schemaVersion !== 1) {
    throw new Error("service state schemaVersion must be 1");
  }
  return {
    schemaVersion: 1,
    core: parseRecord(parsed.core, "core"),
    sync: parseRecord(parsed.sync, "sync"),
  };
}

export function createDefaultServiceState(now: Date = new Date()): ServiceState {
  const updatedAt = now.toISOString();
  return {
    schemaVersion: 1,
    core: {
      mode: "on-demand",
      desiredMode: "on-demand",
      phase: "stable",
      updatedAt,
      failure: null,
    },
    sync: {
      mode: "disabled",
      desiredMode: "disabled",
      phase: "stable",
      updatedAt,
      failure: null,
    },
  };
}

export function serviceStatePath(stateDirectory: string): string {
  if (!isAbsolute(stateDirectory)) {
    throw new Error("service stateDirectory must be absolute");
  }
  return join(stateDirectory, "services.json");
}

export async function readServiceState(stateDirectory: string): Promise<ServiceState | undefined> {
  try {
    return parseServiceState(
      JSON.parse(await readFile(serviceStatePath(stateDirectory), "utf8")) as unknown,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function writeServiceState(
  stateDirectory: string,
  state: ServiceState,
): Promise<void> {
  const path = serviceStatePath(stateDirectory);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(parseServiceState(state), null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
