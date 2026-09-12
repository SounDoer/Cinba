import type { DeploymentFailure } from "./status.ts";
import { startCoreService, stopCoreService } from "./core-service.ts";
import { removeCurrentRelease, switchCurrentRelease } from "./switch-release.ts";
import { verifyCoreConnection, waitForHealthyRevision } from "./verify.ts";

type VerificationOptions = {
  releasesRoot: string;
  currentLink: string;
  targetRevision: string;
  previousRevision?: string;
  healthUrl: string;
  webSocketUrl: string;
};

type VerificationDependencies = {
  startService: () => Promise<void>;
  stopService: () => Promise<void>;
  switchRelease: typeof switchCurrentRelease;
  removeCurrent: typeof removeCurrentRelease;
  waitForHealth: typeof waitForHealthyRevision;
  verifyConnection: typeof verifyCoreConnection;
};

const DEFAULT_DEPENDENCIES: VerificationDependencies = {
  startService: startCoreService,
  stopService: stopCoreService,
  switchRelease: switchCurrentRelease,
  removeCurrent: removeCurrentRelease,
  waitForHealth: waitForHealthyRevision,
  verifyConnection: verifyCoreConnection,
};

async function verifyRevision(
  options: VerificationOptions,
  revision: string,
  dependencies: VerificationDependencies,
): Promise<void> {
  await dependencies.waitForHealth({ url: options.healthUrl, expectedRevision: revision });
  await dependencies.verifyConnection({ url: options.webSocketUrl });
}

async function restorePreviousRelease(
  options: VerificationOptions,
  dependencies: VerificationDependencies,
): Promise<"removed_failed_first_release" | "restored_previous_release"> {
  await dependencies.stopService();
  if (options.previousRevision === undefined) {
    await dependencies.removeCurrent({
      releasesRoot: options.releasesRoot,
      currentLink: options.currentLink,
      expectedCurrentRevision: options.targetRevision,
    });
    return "removed_failed_first_release";
  }

  await dependencies.switchRelease({
    releasesRoot: options.releasesRoot,
    currentLink: options.currentLink,
    targetRevision: options.previousRevision,
    expectedCurrentRevision: options.targetRevision,
  });
  await dependencies.startService();
  await verifyRevision(options, options.previousRevision, dependencies);
  return "restored_previous_release";
}

/** Start and verify an activated release, restoring the last good release on failure. */
export async function verifyActivatedRelease(
  options: VerificationOptions,
  overrides: Partial<VerificationDependencies> = {},
): Promise<
  | { kind: "succeeded" }
  | { kind: "failed"; failure: Extract<DeploymentFailure, "start" | "health">; cause: unknown }
  | { kind: "rolled_back"; failure: Extract<DeploymentFailure, "start" | "health">; cause: unknown }
> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  let failure: Extract<DeploymentFailure, "start" | "health"> = "start";
  try {
    await dependencies.startService();
    failure = "health";
    await verifyRevision(options, options.targetRevision, dependencies);
    return { kind: "succeeded" };
  } catch (error) {
    try {
      const recovery = await restorePreviousRelease(options, dependencies);
      if (recovery === "removed_failed_first_release") {
        return { kind: "failed", failure, cause: error };
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Activated release failed and the previous release could not be restored",
        { cause: rollbackError },
      );
    }
    return { kind: "rolled_back", failure, cause: error };
  }
}
