export const DEPLOYMENT_PHASES = [
  "idle",
  "preparing",
  "checking",
  "waiting_for_drain",
  "switching",
  "verifying",
  "succeeded",
  "rolled_back",
  "failed",
] as const;

export const DEPLOYMENT_FAILURES = [
  "fetch",
  "checkout",
  "install",
  "checks",
  "drain",
  "start",
  "health",
  "rollback",
] as const;

export type DeploymentPhase = (typeof DEPLOYMENT_PHASES)[number];
export type DeploymentFailure = (typeof DEPLOYMENT_FAILURES)[number];

export type DeploymentStatus = {
  version: 1;
  phase: DeploymentPhase;
  updatedAt: string;
  targetRevision?: string;
  runningRevision?: string;
  previousRevision?: string;
  failedRevision?: string;
  failure?: DeploymentFailure;
};

const ALLOWED_FIELDS = new Set([
  "version",
  "phase",
  "updatedAt",
  "targetRevision",
  "runningRevision",
  "previousRevision",
  "failedRevision",
  "failure",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function optionalRevision(value: unknown): value is string | undefined {
  return value === undefined || isRevision(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

/** Parse the public, deliberately small status surface exposed to deployment observers. */
export function parseDeploymentStatus(value: unknown): DeploymentStatus | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !ALLOWED_FIELDS.has(key))) {
    return undefined;
  }
  if (
    value.version !== 1 ||
    !DEPLOYMENT_PHASES.includes(value.phase as DeploymentPhase) ||
    !isIsoDate(value.updatedAt) ||
    !optionalRevision(value.targetRevision) ||
    !optionalRevision(value.runningRevision) ||
    !optionalRevision(value.previousRevision) ||
    !optionalRevision(value.failedRevision) ||
    (value.failure !== undefined &&
      !DEPLOYMENT_FAILURES.includes(value.failure as DeploymentFailure))
  ) {
    return undefined;
  }
  if (value.phase !== "idle" && value.targetRevision === undefined) {
    return undefined;
  }
  if (value.failure !== undefined && value.phase !== "failed" && value.phase !== "rolled_back") {
    return undefined;
  }

  return {
    version: 1,
    phase: value.phase as DeploymentPhase,
    updatedAt: value.updatedAt,
    ...(value.targetRevision && { targetRevision: value.targetRevision.toLowerCase() }),
    ...(value.runningRevision && { runningRevision: value.runningRevision.toLowerCase() }),
    ...(value.previousRevision && { previousRevision: value.previousRevision.toLowerCase() }),
    ...(value.failedRevision && { failedRevision: value.failedRevision.toLowerCase() }),
    ...(value.failure === undefined ? {} : { failure: value.failure as DeploymentFailure }),
  };
}

export function stringifyDeploymentStatus(status: DeploymentStatus): string {
  const checked = parseDeploymentStatus(status);
  if (!checked) {
    throw new Error("Invalid deployment status");
  }
  return `${JSON.stringify(checked, null, 2)}\n`;
}
