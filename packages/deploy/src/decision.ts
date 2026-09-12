import type { DeploymentFailure, DeploymentStatus } from "./status.ts";

export type DeploymentDecision =
  | { kind: "deploy"; targetRevision: string }
  | { kind: "up_to_date"; targetRevision: string }
  | {
      kind: "quarantined";
      targetRevision: string;
      failure: DeploymentFailure | undefined;
    };

function normalizeRevision(value: string | undefined, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${name} is not a full Git revision`);
  }
  return value.toLowerCase();
}

export function decideDeployment(options: {
  targetRevision: string;
  runningRevision?: string;
  previousStatus?: DeploymentStatus;
}): DeploymentDecision {
  const targetRevision = normalizeRevision(options.targetRevision, "targetRevision")!;
  const runningRevision = normalizeRevision(options.runningRevision, "runningRevision");
  const failedRevision = normalizeRevision(
    options.previousStatus?.failedRevision,
    "failedRevision",
  );

  if (targetRevision === runningRevision) {
    return { kind: "up_to_date", targetRevision };
  }

  if (targetRevision === failedRevision) {
    return {
      kind: "quarantined",
      targetRevision,
      failure: options.previousStatus?.failure,
    };
  }

  return { kind: "deploy", targetRevision };
}
