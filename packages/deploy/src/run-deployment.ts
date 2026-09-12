import { ReleaseActivationError, activatePreparedRelease } from "./activate-release.ts";
import { startCoreService } from "./core-service.ts";
import { decideDeployment } from "./decision.ts";
import { fetchProdRevision, isFastForward } from "./git-source.ts";
import { ReleasePreparationError, prepareRelease } from "./prepare-release.ts";
import { recoverInterruptedDeployment } from "./recover-deployment.ts";
import { readDeploymentStatus, writeDeploymentStatus } from "./status-file.ts";
import type { DeploymentFailure } from "./status.ts";
import { advanceDeployment, beginDeployment } from "./transitions.ts";
import { verifyCoreConnection, waitForHealthyRevision } from "./verify.ts";
import { verifyActivatedRelease } from "./verify-activation.ts";

type RunOptions = {
  repoPath: string;
  releasesRoot: string;
  currentLink: string;
  statusPath: string;
  healthUrl: string;
  webSocketUrl: string;
};

type RunDependencies = {
  readStatus: typeof readDeploymentStatus;
  writeStatus: typeof writeDeploymentStatus;
  fetchTarget: typeof fetchProdRevision;
  checkFastForward: typeof isFastForward;
  prepare: typeof prepareRelease;
  activate: typeof activatePreparedRelease;
  verifyActivation: typeof verifyActivatedRelease;
  startService: typeof startCoreService;
  waitForHealth: typeof waitForHealthyRevision;
  verifyConnection: typeof verifyCoreConnection;
  now: () => Date;
  recover: typeof recoverInterruptedDeployment;
};

const DEFAULT_DEPENDENCIES: RunDependencies = {
  readStatus: readDeploymentStatus,
  writeStatus: writeDeploymentStatus,
  fetchTarget: fetchProdRevision,
  checkFastForward: isFastForward,
  prepare: prepareRelease,
  activate: activatePreparedRelease,
  verifyActivation: verifyActivatedRelease,
  startService: startCoreService,
  waitForHealth: waitForHealthyRevision,
  verifyConnection: verifyCoreConnection,
  now: () => new Date(),
  recover: recoverInterruptedDeployment,
};

export type DeploymentRunResult =
  | { kind: "up_to_date"; targetRevision: string }
  | { kind: "quarantined"; targetRevision: string; failure: DeploymentFailure | undefined }
  | { kind: "succeeded"; targetRevision: string }
  | { kind: "rolled_back"; targetRevision: string; failure: DeploymentFailure; cause: unknown }
  | { kind: "failed"; targetRevision?: string; failure: DeploymentFailure; cause: unknown };

const TERMINAL_PHASES = new Set(["idle", "succeeded", "rolled_back", "failed"]);

function preparationFailure(
  error: unknown,
): Extract<DeploymentFailure, "checkout" | "install" | "checks"> {
  if (error instanceof ReleasePreparationError) {
    return error.failure;
  }
  if (error instanceof AggregateError) {
    const typed = error.errors.find((item) => item instanceof ReleasePreparationError);
    if (typed instanceof ReleasePreparationError) {
      return typed.failure;
    }
  }
  return "checkout";
}

async function verifyRunningRevision(
  options: RunOptions,
  revision: string,
  dependencies: RunDependencies,
): Promise<void> {
  await dependencies.waitForHealth({ url: options.healthUrl, expectedRevision: revision });
  await dependencies.verifyConnection({ url: options.webSocketUrl });
}

/** Run one locked deployment attempt from origin/prod through activation or rollback. */
export async function runDeployment(
  options: RunOptions,
  overrides: Partial<RunDependencies> = {},
): Promise<DeploymentRunResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const previousStatus = await dependencies.readStatus(options.statusPath);
  if (previousStatus && !TERMINAL_PHASES.has(previousStatus.phase)) {
    return await dependencies.recover(options, previousStatus);
  }

  let targetRevision: string;
  try {
    targetRevision = await dependencies.fetchTarget(options.repoPath);
  } catch (cause) {
    return { kind: "failed", failure: "fetch", cause };
  }

  const runningRevision = previousStatus?.runningRevision;
  const decision = decideDeployment({ targetRevision, runningRevision, previousStatus });
  if (decision.kind !== "deploy") {
    return decision;
  }

  let status = beginDeployment({
    targetRevision,
    runningRevision,
    previousStatus,
    now: dependencies.now(),
  });
  await dependencies.writeStatus(options.statusPath, status);

  const moveTo = async (
    phase: "checking" | "waiting_for_drain" | "switching" | "verifying" | "succeeded",
  ) => {
    const next = advanceDeployment(status, phase, { now: dependencies.now() });
    await dependencies.writeStatus(options.statusPath, next);
    status = next;
  };
  const fail = async (failure: DeploymentFailure, cause: unknown): Promise<DeploymentRunResult> => {
    const next = advanceDeployment(status, "failed", {
      failure,
      now: dependencies.now(),
    });
    await dependencies.writeStatus(options.statusPath, next);
    status = next;
    return { kind: "failed", targetRevision, failure, cause };
  };

  if (runningRevision !== undefined) {
    let fastForward: boolean;
    try {
      fastForward = await dependencies.checkFastForward(
        options.repoPath,
        runningRevision,
        targetRevision,
      );
    } catch (cause) {
      return await fail("checks", cause);
    }
    if (!fastForward) {
      return await fail("checks", new Error("origin/prod is not a fast-forward deployment"));
    }
  }

  let progressError: unknown;
  try {
    await dependencies.prepare({
      repoPath: options.repoPath,
      releasesRoot: options.releasesRoot,
      targetRevision,
      async onChecking() {
        try {
          await moveTo("checking");
        } catch (error) {
          progressError = error;
          throw error;
        }
      },
    });
  } catch (cause) {
    if (
      cause === progressError ||
      (cause instanceof AggregateError && cause.errors.includes(progressError))
    ) {
      throw cause;
    }
    return await fail(preparationFailure(cause), cause);
  }

  await moveTo("waiting_for_drain");
  await moveTo("switching");
  try {
    await dependencies.activate({
      releasesRoot: options.releasesRoot,
      currentLink: options.currentLink,
      targetRevision,
      expectedCurrentRevision: runningRevision,
    });
  } catch (cause) {
    if (!(cause instanceof ReleaseActivationError)) {
      throw cause;
    }
    if (cause.failure === "switch" && runningRevision !== undefined) {
      try {
        await dependencies.startService();
        await verifyRunningRevision(options, runningRevision, dependencies);
      } catch (rollbackCause) {
        return await fail(
          "rollback",
          new AggregateError(
            [cause, rollbackCause],
            "Switch failed and the old core did not recover",
            {
              cause: rollbackCause,
            },
          ),
        );
      }
    }
    return await fail(cause.failure, cause);
  }

  await moveTo("verifying");
  let verification: Awaited<ReturnType<typeof verifyActivatedRelease>>;
  try {
    verification = await dependencies.verifyActivation({
      releasesRoot: options.releasesRoot,
      currentLink: options.currentLink,
      targetRevision,
      previousRevision: runningRevision,
      healthUrl: options.healthUrl,
      webSocketUrl: options.webSocketUrl,
    });
  } catch (cause) {
    return await fail("rollback", cause);
  }

  if (verification.kind === "succeeded") {
    await moveTo("succeeded");
    return { kind: "succeeded", targetRevision };
  }

  const next = advanceDeployment(status, verification.kind, {
    failure: verification.failure,
    now: dependencies.now(),
  });
  await dependencies.writeStatus(options.statusPath, next);
  return {
    kind: verification.kind,
    targetRevision,
    failure: verification.failure,
    cause: verification.cause,
  };
}
