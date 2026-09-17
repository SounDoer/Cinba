import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  type CoreHealth,
  type LocalCoreControlStatus,
  probeCoreHealth,
  requestLocalCoreLifetime,
  requestLocalCoreStatus,
  requestLocalCoreStop,
} from "@cinba/core-client";
import { type LocalCoreConfig, createLocalCoreConfig } from "./config.ts";
import { acquireStartLock } from "./start-lock.ts";

type RuntimeRecord = {
  pid: number;
  repositoryRoot: string;
  startedAt: string;
};

type ControlRecord = {
  pid: number;
  repositoryRoot: string;
  token: string;
};

export type LocalCoreStatus = {
  state: "stopped" | "running" | "draining";
  running: boolean;
  managed: boolean;
  pid?: number;
  lifetime?: "persistent" | "on-demand" | "external";
  clientCount?: number;
  safeToStop?: boolean;
  health?: CoreHealth;
};

export type EnsureLocalCoreOptions = {
  config?: LocalCoreConfig;
  expectedRevision?: string;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  probe?: (baseUrl: string) => Promise<CoreHealth | undefined>;
  requestStatus?: (baseUrl: string, token: string) => Promise<LocalCoreControlStatus | undefined>;
  spawnCore?: (config: LocalCoreConfig, controlToken: string, revision: string) => ChildProcess;
  requestLifetime?: (
    baseUrl: string,
    token: string,
    lifetime: "persistent" | "on-demand",
  ) => Promise<boolean>;
  requestStop?: (baseUrl: string, token: string) => Promise<boolean>;
  acquireLock?: (path: string) => Promise<() => void>;
  delay?: (milliseconds: number) => Promise<void>;
};

export type StopLocalCoreOptions = {
  config?: LocalCoreConfig;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  probe?: (baseUrl: string) => Promise<CoreHealth | undefined>;
  requestStatus?: (baseUrl: string, token: string) => Promise<LocalCoreControlStatus | undefined>;
  requestStop?: (baseUrl: string, token: string) => Promise<boolean>;
  delay?: (milliseconds: number) => Promise<void>;
};

export type NormalizeLocalCoreOptions = Pick<
  EnsureLocalCoreOptions,
  "config" | "probe" | "requestStatus" | "requestLifetime"
>;

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

export function createCoreProcessEnvironment(
  controlToken: string,
  environment: NodeJS.ProcessEnv = process.env,
  config = createLocalCoreConfig(),
  revision = resolveLocalCoreRevision(config.repositoryRoot),
): NodeJS.ProcessEnv {
  const stableEnvironment = { ...environment };
  delete stableEnvironment.CINBA_DEFAULT_CORE_NAME;
  const port = new URL(config.baseUrl).port;
  if (!port) {
    throw new Error("The local Core URL must contain an explicit port");
  }
  return {
    ...stableEnvironment,
    // process.execPath is electron.exe when Desktop calls the manager. Without
    // this, Electron loads serverEntry as an app and stays alive after Core stops.
    ELECTRON_RUN_AS_NODE: "1",
    CINBA_CORE_LIFETIME: "on-demand",
    CINBA_REVISION: revision,
    CINBA_LOCAL_CONTROL_TOKEN: controlToken,
    CINBA_PORT: port,
    CINBA_STATE_DIR: config.stateDirectory,
    PI_CODING_AGENT_DIR: config.piAgentDirectory,
    ...(config.defaultCoreName ? { CINBA_DEFAULT_CORE_NAME: config.defaultCoreName } : {}),
  };
}

/** Resolve the source checkout identity advertised by a manager-owned local Core. */
export function resolveLocalCoreRevision(
  repositoryRoot: string,
  readRevision: (root: string) => string = (root) =>
    execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
    }),
): string {
  const revision = readRevision(repositoryRoot).trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error("The local Cinba checkout did not resolve to a full Git revision");
  }
  return revision;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readRuntime(path: string): RuntimeRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RuntimeRecord>;
    return Number.isInteger(parsed.pid) &&
      typeof parsed.repositoryRoot === "string" &&
      typeof parsed.startedAt === "string"
      ? (parsed as RuntimeRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

function readControl(path: string): ControlRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ControlRecord>;
    return Number.isInteger(parsed.pid) &&
      typeof parsed.repositoryRoot === "string" &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0
      ? (parsed as ControlRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

function writeRuntime(config: LocalCoreConfig, record: RuntimeRecord): void {
  const temporary = `${config.runtimePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, config.runtimePath);
}

function writeControl(config: LocalCoreConfig, record: ControlRecord): void {
  const temporary = `${config.controlPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, config.controlPath);
}

function removeRuntime(config: LocalCoreConfig, pid: number): void {
  if (readRuntime(config.runtimePath)?.pid !== pid) {
    return;
  }
  try {
    unlinkSync(config.runtimePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function removeControl(config: LocalCoreConfig, pid: number): void {
  if (readControl(config.controlPath)?.pid !== pid) {
    return;
  }
  try {
    unlinkSync(config.controlPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function defaultSpawnCore(
  config: LocalCoreConfig,
  controlToken: string,
  revision: string,
): ChildProcess {
  mkdirSync(config.stateDirectory, { recursive: true });
  mkdirSync(dirname(config.logPath), { recursive: true });
  const log = openSync(config.logPath, "a", 0o600);
  try {
    const child = spawn(process.execPath, [config.serverEntry], {
      cwd: config.repositoryRoot,
      detached: true,
      env: createCoreProcessEnvironment(
        controlToken,
        { ...process.env, ...config.environment },
        config,
        revision,
      ),
      stdio: ["ignore", log, log],
      windowsHide: true,
    });
    child.unref();
    return child;
  } finally {
    closeSync(log);
  }
}

export async function inspectLocalCore(
  config = createLocalCoreConfig(),
  probe: (baseUrl: string) => Promise<CoreHealth | undefined> = probeCoreHealth,
  requestStatus: (
    baseUrl: string,
    token: string,
  ) => Promise<LocalCoreControlStatus | undefined> = requestLocalCoreStatus,
): Promise<LocalCoreStatus> {
  const health = await probe(config.baseUrl);
  if (!health) {
    return { state: "stopped", running: false, managed: false };
  }

  const runtime = readRuntime(config.runtimePath);
  const control = readControl(config.controlPath);
  const ownsRecords = Boolean(
    runtime &&
    control &&
    runtime.pid === control.pid &&
    runtime.repositoryRoot === config.repositoryRoot &&
    control.repositoryRoot === config.repositoryRoot &&
    processIsAlive(runtime.pid),
  );
  const detail = ownsRecords ? await requestStatus(config.baseUrl, control!.token) : undefined;
  const managed = Boolean(detail && detail.pid === runtime!.pid);
  return {
    state: detail?.draining ? "draining" : "running",
    running: true,
    managed,
    pid: managed ? runtime?.pid : undefined,
    lifetime: managed ? detail?.lifetime : "external",
    clientCount: detail?.clientCount,
    safeToStop: detail?.safeToStop ?? health.safeToRestart,
    health,
  };
}

async function ensureOnDemandLifetime(
  status: LocalCoreStatus,
  config: LocalCoreConfig,
  requestLifetime: NonNullable<EnsureLocalCoreOptions["requestLifetime"]>,
): Promise<LocalCoreStatus> {
  if (!status.managed || status.lifetime !== "persistent") {
    return status;
  }

  const control = readControl(config.controlPath);
  if (
    !control ||
    control.pid !== status.pid ||
    !(await requestLifetime(config.baseUrl, control.token, "on-demand"))
  ) {
    throw new Error("The running Cinba Core could not be returned to on-demand availability");
  }
  return { ...status, lifetime: "on-demand" };
}

/** Return a running manager-owned local Core to on-demand without starting one. */
export async function normalizeLocalCoreLifetime(
  options: NormalizeLocalCoreOptions = {},
): Promise<LocalCoreStatus> {
  const config = options.config ?? createLocalCoreConfig();
  const status = await inspectLocalCore(
    config,
    options.probe ?? probeCoreHealth,
    options.requestStatus ?? requestLocalCoreStatus,
  );
  return await ensureOnDemandLifetime(
    status,
    config,
    options.requestLifetime ?? requestLocalCoreLifetime,
  );
}

/** Ensure the one shared local Core is healthy, starting it in the background when absent. */
export async function ensureLocalCore(
  options: EnsureLocalCoreOptions = {},
): Promise<LocalCoreStatus> {
  const config = options.config ?? createLocalCoreConfig();
  const probe = options.probe ?? probeCoreHealth;
  const statusRequest = options.requestStatus ?? requestLocalCoreStatus;
  const lifetimeRequest = options.requestLifetime ?? requestLocalCoreLifetime;
  const expectedRevision =
    options.expectedRevision ?? resolveLocalCoreRevision(config.repositoryRoot);
  let existing = await inspectLocalCore(config, probe, statusRequest);
  existing = await ensureOnDemandLifetime(existing, config, lifetimeRequest);
  if (
    existing.running &&
    existing.state !== "draining" &&
    existing.health?.revision === expectedRevision
  ) {
    return existing;
  }
  if (existing.running && existing.health?.revision !== expectedRevision) {
    if (!existing.managed) {
      throw new Error("A different Cinba Core revision is using the local address");
    }
    if (existing.safeToStop === false || existing.health?.safeToRestart === false) {
      throw new Error("The local Core is busy on an old revision; retry after its work finishes");
    }
  }

  const release = await (options.acquireLock ?? acquireStartLock)(config.startLockPath);
  try {
    let foundInsideLock = await inspectLocalCore(config, probe, statusRequest);
    foundInsideLock = await ensureOnDemandLifetime(foundInsideLock, config, lifetimeRequest);
    if (
      foundInsideLock.running &&
      foundInsideLock.state !== "draining" &&
      foundInsideLock.health?.revision === expectedRevision
    ) {
      return foundInsideLock;
    }
    if (foundInsideLock.running) {
      if (foundInsideLock.health?.revision !== expectedRevision && !foundInsideLock.managed) {
        throw new Error("A different Cinba Core revision is using the local address");
      }
      if (
        foundInsideLock.health?.revision !== expectedRevision &&
        (foundInsideLock.safeToStop === false || foundInsideLock.health?.safeToRestart === false)
      ) {
        throw new Error("The local Core is busy on an old revision; retry after its work finishes");
      }
      const stopped = await stopLocalCore({
        config,
        probe,
        requestStatus: statusRequest,
        requestStop: options.requestStop,
        delay: options.delay,
        pollIntervalMs: options.pollIntervalMs,
      });
      if (stopped.running) {
        throw new Error("The local Core is draining; retry after its current work finishes");
      }
    }

    mkdirSync(config.stateDirectory, { recursive: true });
    const controlToken = randomUUID();
    const child = (options.spawnCore ?? defaultSpawnCore)(config, controlToken, expectedRevision);
    if (child.pid === undefined) {
      throw new Error("The Cinba Core process did not report a PID");
    }
    const pid = child.pid;
    try {
      writeRuntime(config, {
        pid,
        repositoryRoot: config.repositoryRoot,
        startedAt: new Date().toISOString(),
      });
      writeControl(config, { pid, repositoryRoot: config.repositoryRoot, token: controlToken });
    } catch (error) {
      child.kill();
      removeRuntime(config, pid);
      removeControl(config, pid);
      throw error;
    }

    let processError: Error | undefined;
    child.once("error", (error) => {
      processError = error;
    });
    const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const deadline = Date.now() + readyTimeoutMs;
    const delay =
      options.delay ??
      ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

    while (Date.now() < deadline) {
      const health = await probe(config.baseUrl);
      if (health) {
        return {
          state: "running",
          running: true,
          managed: true,
          pid,
          lifetime: "on-demand",
          safeToStop: health.safeToRestart,
          health,
        };
      }
      if (processError || child.exitCode !== null || child.signalCode !== null) {
        removeRuntime(config, pid);
        removeControl(config, pid);
        throw new Error(
          `The Cinba Core process exited before becoming ready${processError ? `: ${processError.message}` : ""}; see ${config.logPath}`,
        );
      }
      await delay(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    }

    removeRuntime(config, pid);
    removeControl(config, pid);
    throw new Error(
      `The Cinba Core did not become ready within ${readyTimeoutMs} milliseconds; see ${config.logPath}`,
    );
  } finally {
    release();
  }
}

/** Ask a manager-owned Core to drain, waiting briefly for an immediately safe stop. */
export async function stopLocalCore(options: StopLocalCoreOptions = {}): Promise<LocalCoreStatus> {
  const config = options.config ?? createLocalCoreConfig();
  const probe = options.probe ?? probeCoreHealth;
  const statusRequest = options.requestStatus ?? requestLocalCoreStatus;
  const current = await inspectLocalCore(config, probe, statusRequest);
  if (!current.running) {
    return current;
  }

  const control = readControl(config.controlPath);
  if (!current.managed || !control || current.pid !== control.pid) {
    throw new Error("The running Cinba Core is external and cannot be stopped by this manager");
  }
  if (!(await (options.requestStop ?? requestLocalCoreStop)(config.baseUrl, control.token))) {
    throw new Error("The running Cinba Core refused the stop request");
  }

  const delay =
    options.delay ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + (options.waitTimeoutMs ?? 3_000);
  while (Date.now() < deadline) {
    if (!(await probe(config.baseUrl))) {
      removeRuntime(config, control.pid);
      removeControl(config, control.pid);
      return { state: "stopped", running: false, managed: false };
    }
    await delay(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  return await inspectLocalCore(config, probe, statusRequest);
}
