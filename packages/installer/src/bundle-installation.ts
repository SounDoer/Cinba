import type { InstallationTransaction } from "./installation-store.ts";
import type { ProductTarget } from "./platform.ts";
import { type VerifiedReleaseBundle, verifyReleaseBundle } from "./release-bundle.ts";
import {
  type ActivateCandidateOptions,
  type StageCandidateOptions,
  activateCandidate,
  stageCandidate,
} from "./transaction.ts";

export type PreparedStableFiles = {
  commit(): Promise<void>;
  rollback(): Promise<void>;
};

export type InstallReleaseBundleOptions = {
  bundleDirectory: string;
  layout: StageCandidateOptions["layout"];
  expectedTarget: ProductTarget;
  prepareStableFiles?: (bundle: VerifiedReleaseBundle) => Promise<PreparedStableFiles>;
  verify?: ActivateCandidateOptions["verify"];
  dataMigration?: ActivateCandidateOptions["dataMigration"];
  transactionId?: string;
  now?: () => Date;
};

export async function installReleaseBundle(
  options: InstallReleaseBundleOptions,
): Promise<InstallationTransaction> {
  const bundle = await verifyReleaseBundle(options.bundleDirectory, options.expectedTarget);
  await stageCandidate({
    sourceDirectory: bundle.payloadDirectory,
    layout: options.layout,
    expectedTarget: options.expectedTarget,
    transactionId: options.transactionId,
    now: options.now,
  });

  let stableFiles: PreparedStableFiles | undefined;
  let transaction: InstallationTransaction;
  try {
    stableFiles = await options.prepareStableFiles?.(bundle);
    transaction = await activateCandidate({
      layout: options.layout,
      verify: options.verify,
      dataMigration: options.dataMigration,
      now: options.now,
    });
  } catch (error) {
    await stableFiles?.rollback();
    throw error;
  }
  // Stable-file commit only removes recovery material. A cleanup failure must not roll files back
  // after the payload transaction has already committed successfully.
  await stableFiles?.commit();
  return transaction;
}
