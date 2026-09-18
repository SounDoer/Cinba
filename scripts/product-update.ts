import { spawn } from "node:child_process";
import { chmod, copyFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ensureLocalCore, inspectLocalCore, stopLocalCore } from "@cinba/core-manager";
import {
  type ProductPaths,
  type ProductTarget,
  type ProductUpdateLease,
  type ServiceMode,
  type UpdateCandidate,
  type UpdateHandoff,
  type UpdateState,
  acquireProductUpdateLease,
  assertUpdateHandoffMatchesReadyState,
  claimTransferredProductUpdateLease,
  claimUpdateHandoff,
  cleanupInstallation,
  cleanupUpdateCandidateCache,
  createUpdateHandoff,
  installPreparedUpdateArtifact,
  prepareProductUpdate,
  readCurrentRelease,
  readUpdateState,
  reapClaimedUpdateHandoffs,
  recordUpdateInstallationResult,
  releasePath,
  removeUpdateHandoff,
  requireProductTarget,
  resolveProductPaths,
  runWithProductUpdateLease,
  writeUpdateHandoff,
  writeUpdateHandoffRecoveringStale,
} from "@cinba/installer";
import {
  type ProductUpdateReadiness,
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

type SupportedPlatform = "win32" | "darwin" | "linux";

export type UpdateRestartCommand = {
  executable: string;
  arguments: string[];
  workingDirectory?: string;
};

export function createUpdateRestartCommand(options: {
  platform: SupportedPlatform;
  paths: Pick<ProductPaths, "launcherPath" | "desktopApplicationPath">;
  handoff: UpdateHandoff;
}): UpdateRestartCommand {
  if (options.handoff.surface === "tui") {
    const workingDirectory = (options.handoff.restart as { workingDirectory: string })
      .workingDirectory;
    return {
      executable: options.paths.launcherPath,
      arguments: ["tui", workingDirectory],
      workingDirectory,
    };
  }
  if (!options.paths.desktopApplicationPath) {
    throw new Error("Cinba Desktop restart is unavailable on this platform");
  }
  return options.platform === "darwin"
    ? {
        executable: "/usr/bin/open",
        arguments: [options.paths.desktopApplicationPath],
      }
    : {
        executable: options.paths.desktopApplicationPath,
        arguments: [],
      };
}

export type RunUpdateRestart = (command: UpdateRestartCommand) => Promise<void>;

export async function restartUpdateSurface(options: {
  platform: SupportedPlatform;
  paths: Pick<ProductPaths, "launcherPath" | "desktopApplicationPath">;
  handoff: UpdateHandoff;
  run?: RunUpdateRestart;
}): Promise<void> {
  const command = createUpdateRestartCommand(options);
  await (
    options.run ??
    ((restart: UpdateRestartCommand) =>
      new Promise<void>((resolveRestart, reject) => {
        const child = spawn(restart.executable, restart.arguments, {
          ...(restart.workingDirectory ? { cwd: restart.workingDirectory } : {}),
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.once("spawn", () => {
          child.unref();
          resolveRestart();
        });
        child.once("error", reject);
      }))
  )(command);
}

function defaultProcessIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitForProcessExit(
  processId: number,
  options: {
    processIsAlive?: (processId: number) => boolean;
    delay?: (milliseconds: number) => Promise<void>;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  if (!Number.isSafeInteger(processId) || processId < 1) {
    throw new Error("wait process id must be a positive integer");
  }
  const processIsAlive = options.processIsAlive ?? defaultProcessIsAlive;
  const delay =
    options.delay ??
    ((milliseconds: number) =>
      new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds)));
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (processIsAlive(processId)) {
    if (Date.now() >= deadline) {
      throw new Error("a Cinba foreground process did not exit in time");
    }
    await delay(100);
  }
}

type DetachedHelper = {
  processId: number;
  terminate: () => Promise<void>;
  detach?: () => void;
};

export async function launchForegroundUpdateHandoff(options: {
  launcherPath: string;
  stateDirectory: string;
  handoff: UpdateHandoff;
  lease: Pick<ProductUpdateLease, "transferTo" | "waitForClaim" | "cancelTransfer">;
  parentProcessId?: number;
  platform: SupportedPlatform;
  makeTemporaryDirectory?: () => Promise<string>;
  writeHandoff?: typeof writeUpdateHandoff;
  copyFile?: (source: string, destination: string) => Promise<void>;
  makeExecutable?: (path: string) => Promise<void>;
  startDetached?: (executable: string, arguments_: readonly string[]) => Promise<DetachedHelper>;
  removeHandoff?: (stateDirectory: string, id?: string) => Promise<void>;
  removeTemporaryDirectory?: (path: string) => Promise<void>;
}): Promise<void> {
  const directory = await (
    options.makeTemporaryDirectory ?? (() => mkdtemp(join(tmpdir(), "cinba-update-")))
  )();
  const helper = join(
    directory,
    options.platform === "win32" ? "cinba-update-helper.exe" : "cinba-update-helper",
  );
  let child: DetachedHelper | undefined;
  try {
    await (options.writeHandoff ?? writeUpdateHandoff)(options.stateDirectory, options.handoff);
    await (options.copyFile ?? copyFile)(options.launcherPath, helper);
    if (options.platform !== "win32") {
      await (options.makeExecutable ?? ((path: string) => chmod(path, 0o700)))(helper);
    }
    child = await (
      options.startDetached ??
      ((executable: string, arguments_: readonly string[]) =>
        new Promise<DetachedHelper>((resolveChild, reject) => {
          const processChild = spawn(executable, [...arguments_], {
            detached: true,
            stdio: "inherit",
            windowsHide: true,
          });
          processChild.once("spawn", () => {
            if (!processChild.pid) {
              reject(new Error("Cinba update helper did not report a PID"));
              return;
            }
            resolveChild({
              processId: processChild.pid,
              terminate: () =>
                new Promise<void>((resolveTermination) => {
                  if (processChild.exitCode !== null) {
                    resolveTermination();
                    return;
                  }
                  processChild.once("exit", () => resolveTermination());
                  if (!processChild.kill()) {
                    resolveTermination();
                  }
                }),
              detach: () => processChild.unref(),
            });
          });
          processChild.once("error", reject);
        }))
    )(helper, ["__update-handoff-helper", String(options.parentProcessId ?? process.pid)]);
    await options.lease.transferTo(child.processId);
    await options.lease.waitForClaim(child.processId);
    child.detach?.();
  } catch (error) {
    try {
      await child?.terminate();
    } catch {
      // Preserve the handoff failure.
    }
    if (child) {
      try {
        await options.lease.cancelTransfer(child.processId);
      } catch {
        // Preserve the handoff failure.
      }
    }
    try {
      await (options.removeHandoff ?? removeUpdateHandoff)(
        options.stateDirectory,
        options.handoff.id,
      );
    } catch {
      // Preserve the handoff failure.
    }
    try {
      await (
        options.removeTemporaryDirectory ??
        ((path: string) => rm(path, { recursive: true, force: true }))
      )(directory);
    } catch {
      // Preserve the handoff failure.
    }
    throw error;
  }
}

export async function beginForegroundUpdateHandoff(options: {
  platform: SupportedPlatform;
  paths: ProductPaths;
  target: ProductTarget;
  surface: "desktop" | "tui";
  blockingProcessId: number;
  expectedVersion: string;
  workingDirectory?: string;
  processIsAlive?: (processId: number) => boolean;
  now?: () => Date;
  acquireLease?: (stateDirectory: string) => Promise<ProductUpdateLease>;
  readState?: typeof readUpdateState;
  reapClaimed?: typeof reapClaimedUpdateHandoffs;
  reportHandoffRecovery?: (warning: string) => void;
  launch?: typeof launchForegroundUpdateHandoff;
}): Promise<void> {
  if (!(options.processIsAlive ?? defaultProcessIsAlive)(options.blockingProcessId)) {
    throw new Error("the foreground update blocking process is not running");
  }
  const lease = await (options.acquireLease ?? acquireProductUpdateLease)(
    options.paths.stateDirectory,
  );
  let failure: unknown;
  try {
    const reaped = await (options.reapClaimed ?? reapClaimedUpdateHandoffs)(
      options.paths.stateDirectory,
      { currentLeaseToken: lease.token },
    );
    const report =
      options.reportHandoffRecovery ??
      ((warning: string) => {
        console.warn(`[cinba] ${warning.slice(0, 2_048)}`);
      });
    for (const id of reaped.retained) {
      report(`retained fresh claimed update handoff claimed-${id}.json`);
    }
    for (const warning of reaped.warnings) {
      report(warning);
    }
    const state = await (options.readState ?? readUpdateState)(options.paths.stateDirectory);
    if (
      state?.phase !== "ready" ||
      !state.candidate?.artifactPath ||
      state.candidate.target !== options.target ||
      state.candidate.version !== options.expectedVersion
    ) {
      throw new Error(
        `foreground update handoff requires ready expected version ${options.expectedVersion}`,
      );
    }
    const handoff = createUpdateHandoff({
      createdAt: (options.now ?? (() => new Date()))(),
      surface: options.surface,
      blockingProcessId: options.blockingProcessId,
      candidate: state.candidate,
      restart:
        options.surface === "desktop" ? {} : { workingDirectory: options.workingDirectory ?? "" },
      leaseToken: lease.token,
    });
    await (options.launch ?? launchForegroundUpdateHandoff)({
      launcherPath: options.paths.launcherPath,
      stateDirectory: options.paths.stateDirectory,
      handoff,
      lease,
      platform: options.platform,
      writeHandoff: (stateDirectory, value) =>
        writeUpdateHandoffRecoveringStale(stateDirectory, value, {
          currentLeaseToken: lease.token,
        }),
    });
  } catch (error) {
    failure = error;
  }
  try {
    await lease.release();
  } catch (error) {
    failure ??= error;
  }
  if (failure) {
    throw failure;
  }
}

export async function runUpdateHandoffWorkerOperation(options: {
  parentProcessId: number;
  claimHandoff: () => Promise<UpdateHandoff>;
  validateHandoff: (handoff: UpdateHandoff) => Promise<void>;
  claimLease: (handoff: UpdateHandoff) => Promise<() => Promise<void>>;
  waitForProcess: (processId: number) => Promise<void>;
  install: (handoff: UpdateHandoff) => Promise<void>;
  restart: (handoff: UpdateHandoff) => Promise<void>;
  removeHandoff: (handoff: UpdateHandoff) => Promise<void>;
  cleanupHelper: () => Promise<void>;
  reportSecondaryFailure?: (error: unknown) => void;
}): Promise<void> {
  let handoff: UpdateHandoff | undefined;
  let release: (() => Promise<void>) | undefined;
  let failure: unknown;
  let installationAttempted = false;
  try {
    handoff = await options.claimHandoff();
    await options.validateHandoff(handoff);
    release = await options.claimLease(handoff);
    await options.waitForProcess(options.parentProcessId);
    await options.waitForProcess(handoff.blockingProcessId);
    installationAttempted = true;
    await options.install(handoff);
  } catch (error) {
    failure = error;
  }
  if (handoff && installationAttempted) {
    try {
      await options.restart(handoff);
    } catch (error) {
      if (failure) {
        options.reportSecondaryFailure?.(error);
      } else {
        failure = error;
      }
    }
  }
  if (handoff) {
    try {
      await options.removeHandoff(handoff);
    } catch (error) {
      if (failure) {
        options.reportSecondaryFailure?.(error);
      } else {
        failure = error;
      }
    }
  }
  if (release) {
    try {
      await release();
    } catch (error) {
      if (failure) {
        options.reportSecondaryFailure?.(error);
      } else {
        failure = error;
      }
    }
  }
  try {
    await options.cleanupHelper();
  } catch (error) {
    if (failure) {
      options.reportSecondaryFailure?.(error);
    } else {
      failure = error;
    }
  }
  if (failure) {
    throw failure;
  }
}

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

type ProductUpdateReadinessDependencies = {
  inspectCore: () => Promise<CoreSnapshot>;
  inspectComponent: (component: "core" | "sync") => Promise<ComponentSnapshot>;
  inspectSync: () => Promise<SyncSnapshot>;
};

export async function inspectProductUpdateReadiness(
  options: ProductUpdateReadinessDependencies,
): Promise<ProductUpdateReadiness> {
  const core = await options.inspectCore();
  const component = {
    core: await options.inspectComponent("core"),
    sync: await options.inspectComponent("sync"),
  };
  if (core.running && core.safeToStop === false) {
    return {
      status: "waiting",
      reasonCode: "core-active-work",
      message: "Cinba cannot install an update while the local Core has active work",
    };
  }
  if (core.running && !core.managed) {
    return {
      status: "waiting",
      reasonCode: "external-core",
      message: "Cinba cannot install an update while an external Core is running",
    };
  }
  if (!core.running && component.core.running) {
    return {
      status: "waiting",
      reasonCode: "unverified-background-core",
      message: "Cinba cannot safely stop an unhealthy Background Core",
    };
  }
  const sync = await options.inspectSync();
  if (sync.running && (!sync.managed || !component.sync.running)) {
    return {
      status: "waiting",
      reasonCode: "external-sync",
      message: "Cinba cannot install an update while an unmanaged Sync is running",
    };
  }
  if (component.sync.running && (!sync.running || !sync.managed)) {
    return {
      status: "waiting",
      reasonCode: "unverified-background-sync",
      message: "Cinba cannot verify the running Background Sync",
    };
  }
  if (sync.running && sync.managed && sync.safeToStop !== true) {
    return {
      status: "waiting",
      reasonCode: "sync-active-requests",
      message: "Cinba cannot install an update while Sync has active requests",
    };
  }
  return { status: "ready" };
}

export async function checkPreparedProductUpdateReadiness(options: {
  expectedVersion: string;
  target: ProductTarget;
  paths: ProductPaths;
  readInstalled?: () => Promise<{ version: string; payloadRoot?: string }>;
  readState?: () => Promise<UpdateState | undefined>;
  inspectReadiness?: () => Promise<ProductUpdateReadiness>;
}): Promise<ProductUpdateReadiness> {
  const current = await (
    options.readInstalled ??
    (async () => {
      const installed = await installedRelease(options.paths, options.target);
      return { version: installed.release.version, payloadRoot: installed.payloadRoot };
    })
  )();
  const state = await (
    options.readState ?? (() => readUpdateState(options.paths.stateDirectory))
  )();
  if (
    state?.phase !== "ready" ||
    state.currentVersion !== current.version ||
    !state.candidate?.artifactPath ||
    state.candidate.target !== options.target ||
    state.candidate.version !== options.expectedVersion
  ) {
    throw new Error(`update readiness requires ready expected version ${options.expectedVersion}`);
  }
  if (options.inspectReadiness) {
    return options.inspectReadiness();
  }
  if (!current.payloadRoot) {
    throw new Error("installed payload root is unavailable");
  }
  const coreConfig = createProductCoreConfig(current.payloadRoot);
  const syncControl = createManagedSyncControlConfig(options.paths.stateDirectory);
  return inspectProductUpdateReadiness({
    inspectCore: () => inspectLocalCore(coreConfig),
    inspectComponent: componentSnapshot,
    inspectSync: () => inspectManagedSyncControl({ config: syncControl }),
  });
}

export async function runProductUpdateReadinessCommand(options: {
  expectedVersion: string;
  target: ProductTarget;
  paths: ProductPaths;
  check?: () => Promise<ProductUpdateReadiness>;
  writeLine?: (line: string) => void;
}): Promise<void> {
  const readiness = await (
    options.check ??
    (() =>
      checkPreparedProductUpdateReadiness({
        expectedVersion: options.expectedVersion,
        target: options.target,
        paths: options.paths,
      }))
  )();
  (options.writeLine ?? console.log)(JSON.stringify(readiness));
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
  let core!: CoreSnapshot;
  const component = {} as { core: ComponentSnapshot; sync: ComponentSnapshot };
  const readiness = await inspectProductUpdateReadiness({
    inspectCore: async () => (core = await options.inspectCore()),
    inspectComponent: async (name) => {
      const snapshot = await options.inspectComponent(name);
      component[name] = snapshot;
      return snapshot;
    },
    inspectSync: options.inspectSync,
  });
  if (readiness.status === "waiting") {
    throw new Error(readiness.message);
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

function scheduleWindowsUpdateHelperCleanup(directory: string): void {
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
        CINBA_HELPER_DIRECTORY: directory,
      },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.once("error", () => {});
  child.unref();
}

function boundedUpdateDiagnostic(error: unknown, secret?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return (secret ? message.replaceAll(secret, "[redacted]") : message).slice(0, 2_048);
}

export async function cleanupCopiedUpdateHelper(options: {
  platform: SupportedPlatform;
  helperPath: string;
  temporaryDirectory?: string;
  removeDirectory?: (path: string) => Promise<void>;
  scheduleWindowsCleanup?: (path: string) => void;
}): Promise<void> {
  const temporaryDirectory = resolve(options.temporaryDirectory ?? tmpdir());
  const helper = resolve(options.helperPath);
  const directory = dirname(helper);
  const expectedName =
    options.platform === "win32" ? "cinba-update-helper.exe" : "cinba-update-helper";
  if (
    basename(helper) !== expectedName ||
    dirname(directory) !== temporaryDirectory ||
    !/^cinba-update-.+$/u.test(basename(directory))
  ) {
    throw new Error("update helper is not a safe Cinba update helper path");
  }
  const [directoryStatus, helperStatus] = await Promise.all([lstat(directory), lstat(helper)]);
  if (directoryStatus.isSymbolicLink() || helperStatus.isSymbolicLink()) {
    throw new Error("update helper cleanup path must not be a symbolic link");
  }
  if (!directoryStatus.isDirectory() || !helperStatus.isFile()) {
    throw new Error("update helper cleanup path is not a regular helper file");
  }
  if (options.platform === "win32") {
    (options.scheduleWindowsCleanup ?? scheduleWindowsUpdateHelperCleanup)(directory);
  } else {
    await (
      options.removeDirectory ?? ((path: string) => rm(path, { recursive: true, force: true }))
    )(directory);
  }
}

export async function runUpdateHandoffHelper(options: { parentProcessId: number }): Promise<void> {
  const platform = process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`Cinba is not available on ${platform}`);
  }
  const target = requireProductTarget();
  const paths = resolveProductPaths({
    platform,
    homeDirectory: homedir(),
    environment: process.env,
  });
  let leaseToken: string | undefined;
  try {
    await runUpdateHandoffWorkerOperation({
      parentProcessId: options.parentProcessId,
      claimHandoff: async () => {
        const claimed = await claimUpdateHandoff(paths.stateDirectory);
        leaseToken = claimed.handoff.leaseToken;
        return claimed.handoff;
      },
      validateHandoff: async (handoff) => {
        if (handoff.candidate.target !== target) {
          throw new Error("update handoff target does not match this launcher");
        }
        await assertUpdateHandoffMatchesReadyState(paths.stateDirectory, handoff);
      },
      claimLease: async (handoff) => {
        const lease = await claimTransferredProductUpdateLease(
          paths.stateDirectory,
          handoff.leaseToken,
        );
        return lease.release;
      },
      waitForProcess: (processId) => waitForProcessExit(processId),
      install: async (handoff) => {
        await assertUpdateHandoffMatchesReadyState(paths.stateDirectory, handoff);
        const state = await readUpdateState(paths.stateDirectory);
        if (state?.phase !== "ready" || !state.candidate) {
          throw new Error("update handoff lost its ready candidate");
        }
        await installPreparedCandidate({
          stateDirectory: paths.stateDirectory,
          currentVersion: state.currentVersion,
          candidate: handoff.candidate,
          install: () =>
            installWithLifecycle({
              paths,
              target,
              artifactPath: handoff.candidate.artifactPath,
              sha256: handoff.candidate.sha256,
              version: handoff.candidate.version,
              revision: handoff.candidate.revision,
            }),
          readCurrent: () => readCurrentRelease(paths),
          cleanup: () => cleanupCompletedUpdate(paths, handoff.candidate),
          reportStateFailure: (error) => {
            console.warn(
              `[cinba] Could not record update state: ${boundedUpdateDiagnostic(error)}`,
            );
          },
          reportCleanupFailure: (error) => {
            console.warn(`[cinba] Update cleanup failed: ${boundedUpdateDiagnostic(error)}`);
          },
        });
      },
      restart: (handoff) => restartUpdateSurface({ platform, paths, handoff }),
      removeHandoff: (handoff) => removeUpdateHandoff(paths.stateDirectory, handoff.id),
      cleanupHelper: () => cleanupCopiedUpdateHelper({ platform, helperPath: process.execPath }),
      reportSecondaryFailure: (error) => {
        console.warn(
          `[cinba] Update follow-up failed: ${boundedUpdateDiagnostic(error, leaseToken)}`,
        );
      },
    });
    console.log("Cinba update installed successfully.");
  } catch (error) {
    throw new Error(`update handoff failed: ${boundedUpdateDiagnostic(error, leaseToken)}`, {
      cause: error,
    });
  }
}

export async function runStableProductUpdate(options: {
  platform: SupportedPlatform;
  paths: ProductPaths;
  target: ProductTarget;
  interactive: boolean;
  confirm: (version: string) => Promise<boolean>;
}): Promise<void> {
  await runWithProductUpdateLease(options.paths.stateDirectory, async (lease) => {
    const reaped = await reapClaimedUpdateHandoffs(options.paths.stateDirectory, {
      currentLeaseToken: lease.token,
    });
    for (const message of [
      ...reaped.retained.map((id) => `retained fresh claimed update handoff claimed-${id}.json`),
      ...reaped.warnings,
    ]) {
      console.warn(`[cinba] ${message.slice(0, 2_048)}`);
    }
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
        const handoff = createUpdateHandoff({
          surface: "tui",
          blockingProcessId: process.pid,
          candidate,
          restart: { workingDirectory: process.cwd() },
          leaseToken: lease.token,
        });
        await launchForegroundUpdateHandoff({
          launcherPath: options.paths.launcherPath,
          stateDirectory: options.paths.stateDirectory,
          handoff,
          lease,
          platform: options.platform,
          writeHandoff: (stateDirectory, value) =>
            writeUpdateHandoffRecoveringStale(stateDirectory, value, {
              currentLeaseToken: lease.token,
            }),
        });
        return "started";
      },
      write: console.log,
    });
  });
}
