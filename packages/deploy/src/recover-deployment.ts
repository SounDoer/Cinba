import { startCoreService } from "./core-service.ts";
import { discardRelease } from "./prepare-release.ts";
import { readCurrentReleaseRevision } from "./switch-release.ts";
import { writeDeploymentStatus } from "./status-file.ts";
import type { DeploymentFailure, DeploymentStatus } from "./status.ts";
import { advanceDeployment } from "./transitions.ts";
import { verifyActivatedRelease } from "./verify-activation.ts";
import { verifyCoreConnection, waitForHealthyRevision } from "./verify.ts";

type RecoveryOptions = {
  repoPath: string;
  releasesRoot: string;
  currentLink: string;
  statusPath: string;
  healthUrl: string;
  webSocketUrl: string;
};

type RecoveryDependencies = {
  readCurrent: typeof readCurrentReleaseRevision;
  writeStatus: typeof writeDeploymentStatus;
  discard: typeof discardRelease;
  startService: typeof startCoreService;
  waitForHealth: typeof waitForHealthyRevision;
  verifyConnection: typeof verifyCoreConnection;
  verifyActivation: typeof verifyActivatedRelease;
  now: () => Date;
};

const DEFAULT_DEPENDENCIES: RecoveryDependencies = {
  readCurrent: readCurrentReleaseRevision,
  writeStatus: writeDeploymentStatus,
  discard: discardRelease,
  startService: startCoreService,
  waitForHealth: waitForHealthyRevision,
  verifyConnection: verifyCoreConnection,
  verifyActivation: verifyActivatedRelease,
  now: () => new Date(),
};

export type InterruptedRecoveryResult =
  | { kind: "succeeded"; targetRevision: string }
  | { kind: "rolled_back"; targetRevision: string; failure: DeploymentFailure; cause: unknown }
  | { kind: "failed"; targetRevision: string; failure: DeploymentFailure; cause: unknown };

async function verifyRevision(
  options: RecoveryOptions,
  revision: string,
  dependencies: RecoveryDependencies,
): Promise<void> {
  await dependencies.startService();
  await dependencies.waitForHealth({ url: options.healthUrl, expectedRevision: revision });
  await dependencies.verifyConnection({ url: options.webSocketUrl });
}

/** Reconcile an interrupted durable phase against the actual current symlink. */
export async function recoverInterruptedDeployment(
  options: RecoveryOptions,
  status: DeploymentStatus,
  overrides: Partial<RecoveryDependencies> = {},
): Promise<InterruptedRecoveryResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  if (!status.targetRevision) {
    throw new Error("Interrupted deployment has no target revision");
  }
  const targetRevision = status.targetRevision;

  const fail = async (
    failure: DeploymentFailure,
    cause: unknown,
  ): Promise<InterruptedRecoveryResult> => {
    const next = advanceDeployment(status, "failed", { failure, now: dependencies.now() });
    await dependencies.writeStatus(options.statusPath, next);
    return { kind: "failed", targetRevision, failure, cause };
  };
  const discard = async (failure: DeploymentFailure, cause: unknown) => {
    try {
      await dependencies.discard({
        repoPath: options.repoPath,
        releasesRoot: options.releasesRoot,
        revision: targetRevision,
      });
    } catch (cleanupCause) {
      return await fail(
        "cleanup",
        new AggregateError([cause, cleanupCause], "Interrupted release could not be discarded", {
          cause: cleanupCause,
        }),
      );
    }
    return await fail(failure, cause);
  };

  let actualRevision: string | undefined;
  try {
    actualRevision = await dependencies.readCurrent({
      releasesRoot: options.releasesRoot,
      currentLink: options.currentLink,
    });
  } catch (cause) {
    return await fail("rollback", cause);
  }

  if (status.phase === "preparing" || status.phase === "checking") {
    if (actualRevision !== status.runningRevision) {
      return await fail("rollback", new Error("Current changed during release preparation"));
    }
    return await discard(
      status.phase === "preparing" ? "checkout" : "checks",
      new Error(`Deployment was interrupted during ${status.phase}`),
    );
  }
  if (status.phase === "waiting_for_drain") {
    if (actualRevision !== status.runningRevision) {
      return await fail("rollback", new Error("Current changed before draining began"));
    }
    return await discard("drain", new Error("Deployment was interrupted before draining"));
  }
  if (status.phase !== "switching" && status.phase !== "verifying") {
    throw new Error(`Deployment phase ${status.phase} does not need recovery`);
  }

  if (actualRevision === targetRevision) {
    let current = status;
    if (current.phase === "switching") {
      current = advanceDeployment(current, "verifying", { now: dependencies.now() });
      await dependencies.writeStatus(options.statusPath, current);
    }
    let verification: Awaited<ReturnType<typeof verifyActivatedRelease>>;
    try {
      verification = await dependencies.verifyActivation({
        releasesRoot: options.releasesRoot,
        currentLink: options.currentLink,
        targetRevision,
        previousRevision: status.runningRevision,
        healthUrl: options.healthUrl,
        webSocketUrl: options.webSocketUrl,
      });
    } catch (cause) {
      const next = advanceDeployment(current, "failed", {
        failure: "rollback",
        now: dependencies.now(),
      });
      await dependencies.writeStatus(options.statusPath, next);
      return { kind: "failed", targetRevision, failure: "rollback", cause };
    }
    const next = advanceDeployment(current, verification.kind, {
      ...(verification.kind === "succeeded" ? {} : { failure: verification.failure }),
      now: dependencies.now(),
    });
    await dependencies.writeStatus(options.statusPath, next);
    return verification.kind === "succeeded"
      ? { kind: "succeeded", targetRevision }
      : {
          kind: verification.kind,
          targetRevision,
          failure: verification.failure,
          cause: verification.cause,
        };
  }

  if (actualRevision === status.runningRevision) {
    if (status.runningRevision !== undefined) {
      try {
        await verifyRevision(options, status.runningRevision, dependencies);
      } catch (cause) {
        return await fail("rollback", cause);
      }
    }
    if (status.phase === "verifying") {
      try {
        await dependencies.discard({
          repoPath: options.repoPath,
          releasesRoot: options.releasesRoot,
          revision: targetRevision,
        });
      } catch (cause) {
        return await fail("cleanup", cause);
      }
      const next = advanceDeployment(status, "rolled_back", {
        failure: "health",
        now: dependencies.now(),
      });
      await dependencies.writeStatus(options.statusPath, next);
      return {
        kind: "rolled_back",
        targetRevision,
        failure: "health",
        cause: new Error("Recovered an interrupted verification rollback"),
      };
    }
    return await discard("switch", new Error("Deployment was interrupted before switching"));
  }

  return await fail("rollback", new Error("Current points to an unexpected release"));
}
