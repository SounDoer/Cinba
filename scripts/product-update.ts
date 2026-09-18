import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import { ensureLocalCore, inspectLocalCore, stopLocalCore } from "@cinba/core-manager";
import {
  type ProductPaths,
  type ProductTarget,
  type ProductUpdateLease,
  type ServiceMode,
  type UpdateCandidate,
  type UpdateState,
  claimTransferredProductUpdateLease,
  cleanupInstallation,
  cleanupUpdateCandidateCache,
  installPreparedUpdateArtifact,
  prepareProductUpdate,
  readCurrentRelease,
  readUpdateState,
  recordUpdateInstallationResult,
  releasePath,
  requireProductTarget,
  resolveProductPaths,
  runWithProductUpdateLease,
} from "@cinba/installer";
import {
  createManagedSyncControlConfig,
  createProductCoreConfig,
  inspectManagedSyncControl,
  inspectProductComponentMode,
  readProductRelease,
  setProductComponentMode,
  stopManagedSyncControl,
  waitForManagedSyncExit,
} from "@cinba/product-runtime";

type ComponentSnapshot = { mode: ServiceMode; running: boolean };
type CoreSnapshot = { running: boolean; managed: boolean; safeToStop?: boolean };
type SyncSnapshot = {
  running: boolean;
  managed: boolean;
  safeToStop?: boolean;
  draining?: boolean;
};

export async function installPreparedCandidate(options: {
  stateDirectory: string;
  currentVersion: string;
  candidate: UpdateCandidate;
  install: () => Promise<void>;
  readCurrent: () => Promise<
    { version: string; revision: string; target: ProductTarget } | undefined
  >;
  record?: typeof recordUpdateInstallationResult;
  reportStateFailure?: (error: unknown) => void;
  cleanup?: () => Promise<void>;
  reportCleanupFailure?: (error: unknown) => void;
}): Promise<void> {
  const record = options.record ?? recordUpdateInstallationResult;
  let installationError: unknown;
  try {
    await options.install();
  } catch (error) {
    installationError = error;
  }
  let current: Awaited<ReturnType<typeof options.readCurrent>>;
  try {
    current = await options.readCurrent();
  } catch (error) {
    if (installationError) {
      options.reportStateFailure?.(error);
      throw installationError;
    }
    throw error;
  }
  const committed =
    current?.version === options.candidate.version &&
    current.revision === options.candidate.revision &&
    current.target === options.candidate.target;
  try {
    await record({
      stateDirectory: options.stateDirectory,
      currentVersion: options.currentVersion,
      candidate: options.candidate,
      result: committed ? "installed" : "failed",
    });
  } catch (error) {
    if (installationError) {
      options.reportStateFailure?.(error);
      throw installationError;
    }
    throw error;
  }
  if (installationError) {
    throw installationError;
  }
  if (!committed) {
    throw new Error("update installation completed without activating the prepared candidate");
  }
  if (options.cleanup) {
    try {
      await options.cleanup();
    } catch (error) {
      options.reportCleanupFailure?.(error);
    }
  }
}

export async function runExplicitProductUpdate(options: {
  interactive: boolean;
  prepare: (options: { automatic: false }) => Promise<UpdateState>;
  confirm: (version: string) => Promise<boolean>;
  install: (candidate: UpdateCandidate) => Promise<void | "started">;
  write: (message: string) => void;
}): Promise<void> {
  const state = await options.prepare({ automatic: false });
  if (state.phase === "current") {
    options.write(`Cinba ${state.currentVersion} is current.`);
    return;
  }
  if (state.phase !== "ready" || !state.candidate?.artifactPath) {
    throw new Error(`Cinba update ended in unexpected state ${state.phase}`);
  }

  options.write(`Cinba ${state.candidate.version} is ready to install.`);
  if (!options.interactive) {
    options.write("Run cinba update in an interactive terminal to install it.");
    return;
  }
  if (!(await options.confirm(state.candidate.version))) {
    options.write("Update kept for later.");
    return;
  }
  const result = await options.install(state.candidate);
  options.write(
    result === "started"
      ? `Cinba ${state.candidate.version} installation started.`
      : `Cinba ${state.candidate.version} installed successfully.`,
  );
}

export async function coordinateProductUpdate(options: {
  inspectCore: () => Promise<CoreSnapshot>;
  inspectComponent: (component: "core" | "sync") => Promise<ComponentSnapshot>;
  inspectSync: () => Promise<SyncSnapshot>;
  setComponentMode: (component: "core" | "sync", mode: ServiceMode) => Promise<void>;
  stopCore: () => Promise<void>;
  stopSync: () => Promise<void>;
  waitForSyncExit?: () => Promise<void>;
  startCore: () => Promise<void>;
  install: () => Promise<void>;
  reportRecoveryFailure?: (error: unknown) => void;
}): Promise<void> {
  const core = await options.inspectCore();
  const component = {
    core: await options.inspectComponent("core"),
    sync: await options.inspectComponent("sync"),
  };
  if (core.running && core.safeToStop === false) {
    throw new Error("Cinba cannot install an update while the local Core has active work");
  }
  if (core.running && !core.managed) {
    throw new Error("Cinba cannot install an update while an external Core is running");
  }
  if (!core.running && component.core.running) {
    throw new Error("Cinba cannot safely stop an unhealthy Background Core");
  }
  const sync = await options.inspectSync();
  if (sync.running && (!sync.managed || !component.sync.running)) {
    throw new Error("Cinba cannot install an update while an unmanaged Sync is running");
  }
  if (component.sync.running && (!sync.running || !sync.managed)) {
    throw new Error("Cinba cannot verify the running Background Sync");
  }
  if (sync.running && sync.managed && sync.safeToStop !== true) {
    throw new Error("Cinba cannot install an update while Sync has active requests");
  }

  let coreModeChanged = false;
  let syncModeChanged = false;
  let syncRestartRequired = false;
  const restore = async (): Promise<unknown[]> => {
    const failures: unknown[] = [];
    const attempt = async (operation: () => Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    if (syncModeChanged) {
      await attempt(() => options.setComponentMode("sync", component.sync.mode));
    } else if (syncRestartRequired) {
      await attempt(async () => {
        const current = await options.inspectSync();
        if (current.running) {
          if (!current.managed) {
            throw new Error("Cinba cannot reconcile an unowned Sync after a failed stop");
          }
          if (current.draining !== true) {
            return;
          }
        }
        if (!options.waitForSyncExit) {
          throw new Error("Cinba cannot confirm Sync exit during update recovery");
        }
        await options.waitForSyncExit();
        await options.setComponentMode("sync", "disabled");
        await options.setComponentMode("sync", component.sync.mode);
      });
    }
    if (coreModeChanged) {
      await attempt(() => options.setComponentMode("core", component.core.mode));
    }
    if (core.running && component.core.mode !== "background") {
      await attempt(options.startCore);
    }
    return failures;
  };

  let originalError: unknown;
  try {
    if (core.running) {
      await options.stopCore();
    }
    if (component.core.mode === "background" && component.core.running) {
      coreModeChanged = true;
      await options.setComponentMode("core", "on-demand");
    }
    if (component.sync.mode === "background" && component.sync.running) {
      // A stop request can be accepted even when its caller later times out. Record the
      // responsibility before sending it so recovery never assumes Sync stayed running.
      syncRestartRequired = true;
      await options.stopSync();
      const stopped = await options.inspectSync();
      if (stopped.running || stopped.managed) {
        throw new Error("Cinba Background Sync did not stop gracefully before update installation");
      }
      syncModeChanged = true;
      // The authenticated control request has already drained Sync. Removing registration now
      // cannot interrupt an in-flight request, including on Windows Task Scheduler.
      await options.setComponentMode("sync", "disabled");
    }
    await options.install();
  } catch (error) {
    originalError = error;
  }

  const recoveryFailures = await restore();
  if (originalError) {
    for (const failure of recoveryFailures) {
      options.reportRecoveryFailure?.(failure);
    }
    throw originalError;
  }
  if (recoveryFailures.length > 0) {
    throw new AggregateError(
      recoveryFailures,
      "Cinba updated but could not restore its prior state",
    );
  }
}

export async function launchWindowsUpdateHelper(options: {
  launcherPath: string;
  artifactPath: string;
  version: string;
  revision: string;
  sha256: string;
  lease: Pick<ProductUpdateLease, "token" | "transferTo" | "waitForClaim" | "cancelTransfer">;
  processId?: number;
  makeTemporaryDirectory?: () => Promise<string>;
  copyFile?: (source: string, destination: string) => Promise<void>;
  removeTemporaryDirectory?: (path: string) => Promise<void>;
  startDetached?: (
    executable: string,
    arguments_: readonly string[],
  ) => Promise<{
    processId: number;
    terminate: () => Promise<void>;
    detach?: () => void;
  }>;
}): Promise<void> {
  const directory = await (
    options.makeTemporaryDirectory ?? (() => mkdtemp(join(tmpdir(), "cinba-update-")))
  )();
  const helper = win32.join(directory, "cinba-update-helper.exe");
  let handoff:
    | {
        processId: number;
        terminate: () => Promise<void>;
        detach?: () => void;
      }
    | undefined;
  try {
    await (options.copyFile ?? copyFile)(options.launcherPath, helper);
    handoff = await (
      options.startDetached ??
      ((executable: string, arguments_: readonly string[]) =>
        new Promise<{
          processId: number;
          terminate: () => Promise<void>;
          detach: () => void;
        }>((resolve, reject) => {
          const child = spawn(executable, [...arguments_], {
            detached: true,
            stdio: "inherit",
            windowsHide: true,
          });
          child.once("spawn", () => {
            if (!child.pid) {
              reject(new Error("Windows update helper did not report a PID"));
              return;
            }
            resolve({
              processId: child.pid,
              terminate: () =>
                new Promise<void>((resolveTermination) => {
                  if (child.exitCode !== null) {
                    resolveTermination();
                    return;
                  }
                  child.once("exit", () => resolveTermination());
                  if (!child.kill()) {
                    resolveTermination();
                  }
                }),
              detach: () => {
                child.unref();
              },
            });
          });
          child.once("error", reject);
        }))
    )(helper, [
      "__update-helper",
      String(options.processId ?? process.pid),
      options.lease.token,
      options.artifactPath,
      options.version,
      options.revision,
      options.sha256,
    ]);
    await options.lease.transferTo(handoff.processId);
    await options.lease.waitForClaim(handoff.processId);
    handoff.detach?.();
  } catch (error) {
    try {
      await handoff?.terminate();
    } catch {
      // Preserve the spawn/transfer error that explains why handoff did not start.
    }
    if (handoff) {
      try {
        await options.lease.cancelTransfer(handoff.processId);
      } catch {
        // Preserve the spawn/transfer/claim error.
      }
    }
    try {
      await (
        options.removeTemporaryDirectory ??
        ((path: string) => rm(path, { recursive: true, force: true }))
      )(directory);
    } catch {
      // Preserve the copy/spawn error that explains why handoff did not start.
    }
    throw error;
  }
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitForUpdateParentExit(
  processId: number,
  delay: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (!processExists(processId)) {
      return;
    }
    await delay(100);
  }
  throw new Error("the Cinba launcher did not exit in time");
}

type SupportedPlatform = "win32" | "darwin" | "linux";

async function installedRelease(paths: ProductPaths, target: ProductTarget) {
  const current = await readCurrentRelease(paths);
  if (!current) {
    throw new Error("Cinba is not installed");
  }
  const payloadRoot = releasePath(paths, current);
  const release = await readProductRelease(payloadRoot);
  if (release.target !== target) {
    throw new Error(`installed ${release.target} release does not match ${target}`);
  }
  return { payloadRoot, release };
}

async function cleanupCompletedUpdate(
  paths: ProductPaths,
  candidate: UpdateCandidate,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    const result = await cleanupInstallation(paths);
    failures.push(
      ...result.failed.map(
        (failure) =>
          new Error(`could not remove obsolete installation path ${failure.path}`, {
            cause: failure.error,
          }),
      ),
    );
  } catch (error) {
    failures.push(error);
  }
  try {
    await cleanupUpdateCandidateCache({
      cacheDirectory: paths.cacheDirectory,
      revision: candidate.revision,
      artifactPath: candidate.artifactPath,
    });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Cinba updated but cleanup did not fully complete");
  }
}

async function componentSnapshot(component: "core" | "sync"): Promise<ComponentSnapshot> {
  const status = await inspectProductComponentMode(component);
  if (status.state === "not-installed") {
    throw new Error("Cinba is not installed");
  }
  if (status.state === "not-created") {
    if (component === "sync") {
      return { mode: "disabled", running: false };
    }
    throw new Error("Cinba Core service state does not exist");
  }
  if (status.state === "unknown" || status.phase !== "stable") {
    throw new Error(`${status.component} service state is not stable`);
  }
  return { mode: status.state, running: status.running };
}

async function installWithLifecycle(options: {
  paths: ProductPaths;
  target: ProductTarget;
  artifactPath: string;
  sha256: string;
  version: string;
  revision: string;
}): Promise<void> {
  const before = await installedRelease(options.paths, options.target);
  const oldCoreConfig = createProductCoreConfig(before.payloadRoot);
  const syncControl = createManagedSyncControlConfig(options.paths.stateDirectory);
  await coordinateProductUpdate({
    inspectCore: () => inspectLocalCore(oldCoreConfig),
    inspectComponent: componentSnapshot,
    inspectSync: () => inspectManagedSyncControl({ config: syncControl }),
    setComponentMode: async (component, mode) => {
      await setProductComponentMode(component, mode);
    },
    stopCore: async () => {
      const status = await stopLocalCore({ config: oldCoreConfig });
      if (status.running) {
        throw new Error("Cinba Core did not stop before update installation");
      }
    },
    stopSync: () => stopManagedSyncControl({ config: syncControl }),
    waitForSyncExit: () => waitForManagedSyncExit({ config: syncControl }),
    startCore: async () => {
      const current = await installedRelease(options.paths, options.target);
      await ensureLocalCore({
        config: createProductCoreConfig(current.payloadRoot),
        expectedRevision: current.release.revision,
      });
    },
    install: () =>
      installPreparedUpdateArtifact({
        target: options.target,
        artifactPath: options.artifactPath,
        expectedVersion: options.version,
        expectedRevision: options.revision,
        expectedSha256: options.sha256,
      }),
    reportRecoveryFailure: (error) => {
      console.warn(
        `[cinba] Could not fully restore pre-update state: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
}

function scheduleWindowsUpdateHelperCleanup(helper: string): void {
  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      "Wait-Process -Id $env:CINBA_HELPER_PID -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $env:CINBA_HELPER_DIRECTORY -Recurse -Force -ErrorAction SilentlyContinue",
    ],
    {
      detached: true,
      env: {
        ...process.env,
        CINBA_HELPER_PID: String(process.pid),
        CINBA_HELPER_DIRECTORY: dirname(helper),
      },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.once("error", () => {});
  child.unref();
}

export async function runWindowsUpdateHelperOperation(options: {
  claimUpdateLease: () => Promise<() => Promise<void>>;
  waitForParent: () => Promise<void>;
  validateTarget: () => Promise<void>;
  install: () => Promise<void>;
  cleanup: () => Promise<void>;
}): Promise<void> {
  let failure: unknown;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await options.claimUpdateLease();
    await options.waitForParent();
    await options.validateTarget();
    await options.install();
  } catch (error) {
    failure = error;
  }
  if (release) {
    try {
      await release();
    } catch (error) {
      failure ??= error;
    }
  }
  try {
    await options.cleanup();
  } catch (error) {
    failure ??= error;
  }
  if (failure) {
    throw failure;
  }
}

async function preparedWindowsUpdate(
  paths: ProductPaths,
  options: {
    artifactPath: string;
    version: string;
    revision: string;
    sha256: string;
  },
): Promise<{ currentVersion: string; candidate: UpdateCandidate }> {
  const state = await readUpdateState(paths.stateDirectory);
  const candidate = state?.candidate;
  if (
    state?.phase !== "ready" ||
    !candidate ||
    candidate.target !== "windows-x64" ||
    candidate.artifactPath !== options.artifactPath ||
    candidate.version !== options.version ||
    candidate.revision !== options.revision ||
    candidate.sha256 !== options.sha256
  ) {
    throw new Error("Windows update helper state does not match the prepared candidate");
  }
  return { currentVersion: state.currentVersion, candidate };
}

export async function runWindowsUpdateHelper(options: {
  parentProcessId: number;
  leaseToken: string;
  artifactPath: string;
  version: string;
  revision: string;
  sha256: string;
}): Promise<void> {
  let paths: ProductPaths | undefined;
  let prepared: Awaited<ReturnType<typeof preparedWindowsUpdate>> | undefined;
  await runWindowsUpdateHelperOperation({
    claimUpdateLease: async () => {
      if (requireProductTarget() !== "windows-x64" || process.platform !== "win32") {
        throw new Error("the Windows update helper is available only on Windows");
      }
      paths = resolveProductPaths({
        platform: "win32",
        homeDirectory: homedir(),
        environment: process.env,
      });
      const lease = await claimTransferredProductUpdateLease(
        paths.stateDirectory,
        options.leaseToken,
      );
      return lease.release;
    },
    waitForParent: () => waitForUpdateParentExit(options.parentProcessId),
    validateTarget: async () => {
      if (!paths) {
        throw new Error("Windows update paths were not initialized");
      }
      prepared = await preparedWindowsUpdate(paths, options);
    },
    install: async () => {
      if (!paths || !prepared) {
        throw new Error("Windows update paths were not initialized");
      }
      const currentPaths = paths;
      const currentPrepared = prepared;
      await installPreparedCandidate({
        stateDirectory: currentPaths.stateDirectory,
        currentVersion: currentPrepared.currentVersion,
        candidate: currentPrepared.candidate,
        install: () =>
          installWithLifecycle({
            paths: currentPaths,
            target: "windows-x64",
            artifactPath: options.artifactPath,
            sha256: options.sha256,
            version: options.version,
            revision: options.revision,
          }),
        readCurrent: () => readCurrentRelease(currentPaths),
        cleanup: () => cleanupCompletedUpdate(currentPaths, currentPrepared.candidate),
        reportStateFailure: (error) => {
          console.warn(
            `[cinba] Could not record update failure: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
        reportCleanupFailure: (error) => {
          console.warn(
            `[cinba] Update installed, but cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      });
      console.log("Cinba update installed successfully.");
    },
    cleanup: async () => {
      if (basename(process.execPath) === "cinba-update-helper.exe") {
        scheduleWindowsUpdateHelperCleanup(process.execPath);
      }
    },
  });
}

export async function runStableProductUpdate(options: {
  platform: SupportedPlatform;
  paths: ProductPaths;
  target: ProductTarget;
  interactive: boolean;
  confirm: (version: string) => Promise<boolean>;
}): Promise<void> {
  await runWithProductUpdateLease(options.paths.stateDirectory, async (lease) => {
    const current = await installedRelease(options.paths, options.target);
    await runExplicitProductUpdate({
      interactive: options.interactive,
      prepare: ({ automatic }) =>
        prepareProductUpdate({
          currentVersion: current.release.version,
          currentRevision: current.release.revision,
          target: options.target,
          stateDirectory: options.paths.stateDirectory,
          cacheDirectory: options.paths.cacheDirectory,
          automatic,
          lease,
        }),
      confirm: options.confirm,
      install: async (candidate) => {
        if (!candidate.artifactPath) {
          throw new Error("prepared update does not have an artifact");
        }
        if (options.platform === "win32") {
          await launchWindowsUpdateHelper({
            launcherPath: options.paths.launcherPath,
            artifactPath: candidate.artifactPath,
            version: candidate.version,
            revision: candidate.revision,
            sha256: candidate.sha256,
            lease,
          });
          return "started";
        }
        await installPreparedCandidate({
          stateDirectory: options.paths.stateDirectory,
          currentVersion: current.release.version,
          candidate,
          install: () =>
            installWithLifecycle({
              paths: options.paths,
              target: options.target,
              artifactPath: candidate.artifactPath!,
              sha256: candidate.sha256,
              version: candidate.version,
              revision: candidate.revision,
            }),
          readCurrent: () => readCurrentRelease(options.paths),
          cleanup: () => cleanupCompletedUpdate(options.paths, candidate),
          reportStateFailure: (error) => {
            console.warn(
              `[cinba] Could not record update failure: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
          reportCleanupFailure: (error) => {
            console.warn(
              `[cinba] Update installed, but cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        });
      },
      write: console.log,
    });
  });
}
