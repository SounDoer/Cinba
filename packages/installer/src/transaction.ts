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

function candidateRelease(inventory: ArtifactInventory, transactionId: string): InstalledRelease {
  return {
    version: inventory.version,
    revision: inventory.revision,
    target: inventory.target,
    directory: `.${inventory.revision}.${transactionId}.candidate`,
  };
}

function installedRelease(candidate: InstalledRelease): InstalledRelease {
  return { ...candidate, directory: candidate.revision };
}

async function readInventory(directory: string): Promise<ArtifactInventory> {
  return parseArtifactInventory(
    JSON.parse(await readFile(join(directory, "inventory.json"), "utf8")) as unknown,
  );
}

function sameIdentity(inventory: ArtifactInventory, release: InstalledRelease): boolean {
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

    const id = options.transactionId ?? randomUUID();
    const candidate = candidateRelease(inventory, id);
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
    replacedDirectory = join(
      resolve(options.layout.releasesDirectory),
      `.${target.revision}.${transaction.id}.replaced`,
    );

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
