import {
  type DeploymentFailure,
  type DeploymentPhase,
  type DeploymentStatus,
  parseDeploymentStatus,
} from "./status.ts";

const NEXT_PHASES: Record<DeploymentPhase, ReadonlySet<DeploymentPhase>> = {
  idle: new Set(),
  preparing: new Set(["checking", "failed"]),
  checking: new Set(["waiting_for_drain", "superseded", "failed"]),
  waiting_for_drain: new Set(["switching", "failed"]),
  switching: new Set(["verifying", "rolled_back", "failed"]),
  verifying: new Set(["succeeded", "rolled_back", "failed"]),
  superseded: new Set(),
  succeeded: new Set(),
  rolled_back: new Set(),
  failed: new Set(),
};

function timestamp(now: Date): string {
  if (Number.isNaN(now.valueOf())) {
    throw new Error("Deployment timestamp is invalid");
  }
  return now.toISOString();
}

function checked(status: DeploymentStatus): DeploymentStatus {
  const parsed = parseDeploymentStatus(status);
  if (!parsed) {
    throw new Error("Deployment status is invalid");
  }
  return parsed;
}

export function beginDeployment(options: {
  targetRevision: string;
  runningRevision?: string;
  previousStatus?: DeploymentStatus;
  now?: Date;
}): DeploymentStatus {
  return checked({
    version: 1,
    phase: "preparing",
    updatedAt: timestamp(options.now ?? new Date()),
    targetRevision: options.targetRevision,
    ...(options.runningRevision && {
      runningRevision: options.runningRevision,
    }),
    ...(options.previousStatus?.previousRevision && {
      previousRevision: options.previousStatus.previousRevision,
    }),
    ...(options.previousStatus?.failedRevision && {
      failedRevision: options.previousStatus.failedRevision,
    }),
  });
}

export function advanceDeployment(
  current: DeploymentStatus,
  nextPhase: DeploymentPhase,
  options: { failure?: DeploymentFailure; now?: Date } = {},
): DeploymentStatus {
  if (!NEXT_PHASES[current.phase].has(nextPhase)) {
    throw new Error(`Invalid deployment transition: ${current.phase} -> ${nextPhase}`);
  }
  const isFailure = nextPhase === "failed" || nextPhase === "rolled_back";
  if (isFailure !== (options.failure !== undefined)) {
    throw new Error(
      isFailure
        ? "A failed deployment needs a failure code"
        : "Failure code is only valid at failure",
    );
  }

  const next: DeploymentStatus = {
    ...current,
    phase: nextPhase,
    updatedAt: timestamp(options.now ?? new Date()),
  };
  delete next.failure;

  if (isFailure) {
    next.failedRevision = current.targetRevision;
    next.failure = options.failure;
    if (options.failure === "rollback") {
      delete next.runningRevision;
    }
  }
  if (nextPhase === "succeeded") {
    if (current.runningRevision) {
      next.previousRevision = current.runningRevision;
    } else {
      delete next.previousRevision;
    }
    next.runningRevision = current.targetRevision;
    delete next.failedRevision;
  }
  return checked(next);
}
