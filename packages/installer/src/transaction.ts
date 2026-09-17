import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type ArtifactInventory,
  parseArtifactInventory,
  verifyArtifactInventory,
} from "./inventory.ts";
import { acquireInstallationLock } from "./installation-lock.ts";
import {
  type InstallationFailure,
  type InstallationLayout,
  type InstallationPhase,
  type InstallationTransaction,
  type InstalledRelease,
  clearCurrentRelease,
  readCurrentRelease,
  readInstallationTransaction,
  releasePath,
  writeCurrentRelease,
  writeInstallationTransaction,
} from "./installation-store.ts";
import { type PayloadRelease, parsePayloadRelease } from "./payload-release.ts";
import type { ProductTarget } from "./platform.ts";

export type StageCandidateOptions = {
  sourceDirectory: string;
  layout: InstallationLayout;
  expectedTarget: ProductTarget;
  transactionId?: string;
  now?: () => Date;
};

export type ActivateCandidateOptions = {
  layout: InstallationLayout;
  verify?: (releaseDirectory: string, release: InstalledRelease) => Promise<void>;
  now?: () => Date;
};

export type RecoverInstallationOptions = ActivateCandidateOptions;

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function updateTransaction(
  transaction: InstallationTransaction,
  phase: InstallationPhase,
  now: () => Date,
  failure: InstallationFailure | null = null,
): InstallationTransaction {
  return {
    ...transaction,
    phase,
    updatedAt: now().toISOString(),
    failure,
  };
}

function candidateRelease(metadata: PayloadRelease, transactionId: string): InstalledRelease {
  return {
    version: metadata.version,
    revision: metadata.revision,
    protocolVersion: metadata.protocolVersion,
    dataFormatVersion: metadata.dataFormatVersion,
    target: metadata.target,
    directory: `.${metadata.revision}.${transactionId}.candidate`,
  };
}

function installedRelease(candidate: InstalledRelease): InstalledRelease {
  return { ...candidate, directory: candidate.revision };
}

function sameRelease(left: InstalledRelease | undefined, right: InstalledRelease): boolean {
  return (
    left?.version === right.version &&
    left.revision === right.revision &&
    left.protocolVersion === right.protocolVersion &&
    left.dataFormatVersion === right.dataFormatVersion &&
    left.target === right.target &&
    left.directory === right.directory
  );
}

function replacementPath(
  layout: InstallationLayout,
  release: InstalledRelease,
  transactionId: string,
): string {
  return join(resolve(layout.releasesDirectory), `.${release.revision}.${transactionId}.replaced`);
}

async function readInventory(directory: string): Promise<ArtifactInventory> {
  return parseArtifactInventory(
    JSON.parse(await readFile(join(directory, "inventory.json"), "utf8")) as unknown,
  );
}

async function readReleaseMetadata(directory: string): Promise<PayloadRelease> {
  return parsePayloadRelease(
    JSON.parse(await readFile(join(directory, "release.json"), "utf8")) as unknown,
  );
}

function sameIdentity(
  inventory: ArtifactInventory,
  release: Pick<InstalledRelease, "version" | "revision" | "target">,
): boolean {
  return (
    inventory.version === release.version &&
    inventory.revision === release.revision &&
    inventory.target === release.target
  );
}

async function verifyRelease(directory: string, release: InstalledRelease): Promise<void> {
  const inventory = await readInventory(directory);
  if (!sameIdentity(inventory, release)) {
    throw new Error("release inventory identity does not match the installation transaction");
  }
  const result = await verifyArtifactInventory(directory, inventory);
  if (!result.valid) {
    throw new Error(`release inventory verification failed: ${JSON.stringify(result.problems)}`);
  }
}

export async function stageCandidate(
  options: StageCandidateOptions,
): Promise<InstallationTransaction> {
  if (!isAbsolute(options.sourceDirectory)) {
    throw new Error("candidate sourceDirectory must be an absolute path");
  }
  const release = resolve(options.sourceDirectory);
  if (
    release === resolve(options.layout.programDirectory) ||
    isInside(options.layout.programDirectory, release)
  ) {
    throw new Error("candidate sourceDirectory must be outside the managed program directory");
  }
  const unlock = await acquireInstallationLock(options.layout);
  const now = options.now ?? (() => new Date());
  let transaction: InstallationTransaction | undefined;
  let candidateDirectory: string | undefined;
  try {
    const existing = await readInstallationTransaction(options.layout);
    if (
      existing &&
      existing.phase !== "committed" &&
      existing.phase !== "rolled-back" &&
      existing.phase !== "failed"
    ) {
      throw new Error(`installation transaction ${existing.id} is still ${existing.phase}`);
    }

    const inventory = await readInventory(release);
    if (inventory.target !== options.expectedTarget) {
      throw new Error(
        `candidate target ${inventory.target} does not match ${options.expectedTarget}`,
      );
    }
    const sourceVerification = await verifyArtifactInventory(release, inventory);
    if (!sourceVerification.valid) {
      throw new Error(
        `candidate inventory verification failed: ${JSON.stringify(sourceVerification.problems)}`,
      );
    }

    const metadata = await readReleaseMetadata(release);
    if (!sameIdentity(inventory, metadata)) {
      throw new Error("candidate release metadata does not match its inventory");
    }

    const id = options.transactionId ?? randomUUID();
    const candidate = candidateRelease(metadata, id);
    candidateDirectory = releasePath(options.layout, candidate);
    if (await exists(candidateDirectory)) {
      throw new Error("candidate directory already exists");
    }
    const previous = (await readCurrentRelease(options.layout)) ?? null;
    if (previous && previous.target !== options.expectedTarget) {
      throw new Error(
        `installed target ${previous.target} does not match ${options.expectedTarget}`,
      );
    }
    if (previous && previous.dataFormatVersion > candidate.dataFormatVersion) {
      throw new Error(
        `candidate data format ${candidate.dataFormatVersion} cannot read installed format ${previous.dataFormatVersion}`,
      );
    }
    const timestamp = now().toISOString();
    transaction = {
      schemaVersion: 1,
      id,
      phase: "staging",
      candidate,
      previous,
      startedAt: timestamp,
      updatedAt: timestamp,
      failure: null,
    };
    await writeInstallationTransaction(options.layout, transaction);
    await mkdir(options.layout.releasesDirectory, { recursive: true });
    await cp(release, candidateDirectory, { recursive: true, force: false, errorOnExist: true });
    await writeFile(
      join(candidateDirectory, "inventory.json"),
      `${JSON.stringify(inventory, null, 2)}\n`,
    );
    await verifyRelease(candidateDirectory, candidate);
    transaction = updateTransaction(transaction, "ready", now);
    await writeInstallationTransaction(options.layout, transaction);
    return transaction;
  } catch (error) {
    if (candidateDirectory) {
      await rm(candidateDirectory, { recursive: true, force: true });
    }
    if (transaction) {
      transaction = updateTransaction(transaction, "failed", now, "stage-failed");
      await writeInstallationTransaction(options.layout, transaction);
    }
    throw error;
  } finally {
    await unlock();
  }
}

export async function activateCandidate(
  options: ActivateCandidateOptions,
): Promise<InstallationTransaction> {
  const unlock = await acquireInstallationLock(options.layout);
  const now = options.now ?? (() => new Date());
  let transaction: InstallationTransaction | undefined;
  let targetDirectory: string | undefined;
  let replacedDirectory: string | undefined;
  let replacedRelease = false;
  let targetInstalled = false;
  try {
    transaction = await readInstallationTransaction(options.layout);
    if (!transaction || transaction.phase !== "ready") {
      throw new Error("no verified candidate release is ready to activate");
    }
    const candidateDirectory = releasePath(options.layout, transaction.candidate);
    const target = installedRelease(transaction.candidate);
    targetDirectory = releasePath(options.layout, target);
    replacedDirectory = replacementPath(options.layout, target, transaction.id);

    transaction = updateTransaction(transaction, "switching", now);
    await writeInstallationTransaction(options.layout, transaction);
    if (await exists(targetDirectory)) {
      if (await exists(replacedDirectory)) {
        throw new Error("replacement backup directory already exists");
      }
      await rename(targetDirectory, replacedDirectory);
      replacedRelease = true;
    }
    await rename(candidateDirectory, targetDirectory);
    targetInstalled = true;
    await writeCurrentRelease(options.layout, target);

    transaction = updateTransaction(transaction, "verifying", now);
    await writeInstallationTransaction(options.layout, transaction);
    await (options.verify ?? verifyRelease)(targetDirectory, target);

    transaction = updateTransaction(transaction, "committed", now);
    await writeInstallationTransaction(options.layout, transaction);
    // A replacement backup is intentionally left in place until a separate cleanup pass. Once
    // committed, cleanup failure must never turn a healthy release into a rollback.
    return transaction;
  } catch (activationError) {
    if (!transaction || !targetDirectory || (!targetInstalled && !replacedRelease)) {
      if (transaction) {
        await writeInstallationTransaction(
          options.layout,
          updateTransaction(transaction, "failed", now, "switch-failed"),
        );
      }
      throw activationError;
    }

    try {
      const failure = targetInstalled ? "verification-failed" : "switch-failed";
      transaction = updateTransaction(transaction, "rolling-back", now, failure);
      await writeInstallationTransaction(options.layout, transaction);
      if (transaction.previous) {
        await writeCurrentRelease(options.layout, transaction.previous);
      } else {
        await clearCurrentRelease(options.layout);
      }
      if (targetInstalled) {
        await rm(targetDirectory, { recursive: true, force: true });
      }
      if (replacedRelease && replacedDirectory && (await exists(replacedDirectory))) {
        await rename(replacedDirectory, targetDirectory);
      }
      transaction = updateTransaction(transaction, "rolled-back", now, failure);
      await writeInstallationTransaction(options.layout, transaction);
    } catch (rollbackError) {
      await writeInstallationTransaction(
        options.layout,
        updateTransaction(transaction, "failed", now, "rollback-failed"),
      );
      const combined = new Error("candidate activation and automatic rollback both failed", {
        cause: rollbackError,
      });
      Object.assign(combined, { activationError });
      throw combined;
    }
    throw activationError;
  } finally {
    await unlock();
  }
}

export async function recoverInterruptedInstallation(
  options: RecoverInstallationOptions,
): Promise<InstallationTransaction | undefined> {
  const unlock = await acquireInstallationLock(options.layout);
  const now = options.now ?? (() => new Date());
  let transaction: InstallationTransaction | undefined;
  try {
    transaction = await readInstallationTransaction(options.layout);
    if (!transaction) {
      return undefined;
    }
    if (["ready", "committed", "rolled-back", "failed"].includes(transaction.phase)) {
      return transaction;
    }

    const candidateDirectory = releasePath(options.layout, transaction.candidate);
    const target = installedRelease(transaction.candidate);
    const targetDirectory = releasePath(options.layout, target);
    const replacedDirectory = replacementPath(options.layout, target, transaction.id);

    const rollback = async (): Promise<InstallationTransaction> => {
      const rollingBack = updateTransaction(transaction!, "rolling-back", now, "interrupted");
      transaction = rollingBack;
      await writeInstallationTransaction(options.layout, rollingBack);
      const candidateExists = await exists(candidateDirectory);
      const replacementExists = await exists(replacedDirectory);
      if (rollingBack.previous) {
        await writeCurrentRelease(options.layout, rollingBack.previous);
      } else {
        await clearCurrentRelease(options.layout);
      }
      if (replacementExists) {
        await rm(targetDirectory, { recursive: true, force: true });
        await rename(replacedDirectory, targetDirectory);
      } else if (
        !candidateExists &&
        (!rollingBack.previous || rollingBack.previous.revision !== target.revision)
      ) {
        await rm(targetDirectory, { recursive: true, force: true });
      }
      await rm(candidateDirectory, { recursive: true, force: true });
      const rolledBack = updateTransaction(rollingBack, "rolled-back", now, "interrupted");
      transaction = rolledBack;
      await writeInstallationTransaction(options.layout, rolledBack);
      return rolledBack;
    };

    if (transaction.phase === "staging" || transaction.phase === "rolling-back") {
      return await rollback();
    }

    const current = await readCurrentRelease(options.layout);
    const candidateExists = await exists(candidateDirectory);
    const targetExists = await exists(targetDirectory);
    const switched = targetExists && !candidateExists && sameRelease(current, target);
    if (!switched) {
      return await rollback();
    }

    transaction = updateTransaction(transaction, "verifying", now, null);
    await writeInstallationTransaction(options.layout, transaction);
    try {
      await (options.verify ?? verifyRelease)(targetDirectory, target);
    } catch {
      return await rollback();
    }
    transaction = updateTransaction(transaction, "committed", now);
    await writeInstallationTransaction(options.layout, transaction);
    return transaction;
  } catch (recoveryError) {
    if (transaction && transaction.phase !== "failed") {
      await writeInstallationTransaction(
        options.layout,
        updateTransaction(transaction, "failed", now, "rollback-failed"),
      );
    }
    throw recoveryError;
  } finally {
    await unlock();
  }
}
