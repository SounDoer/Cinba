import { type ChildProcess, spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { probeCoreHealth, type CoreHealth } from "@cinba/core-client";
import { createLocalCoreConfig, type LocalCoreConfig } from "./config.ts";
import { acquireStartLock } from "./start-lock.ts";

type RuntimeRecord = {
  pid: number;
  repositoryRoot: string;
  startedAt: string;
};

export type LocalCoreStatus = {
  running: boolean;
  managed: boolean;
  pid?: number;
  health?: CoreHealth;
};

export type EnsureLocalCoreOptions = {
  config?: LocalCoreConfig;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  probe?: (baseUrl: string) => Promise<CoreHealth | undefined>;
  spawnCore?: (config: LocalCoreConfig) => ChildProcess;
  acquireLock?: (path: string) => Promise<() => void>;
  delay?: (milliseconds: number) => Promise<void>;
};

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

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

function writeRuntime(config: LocalCoreConfig, record: RuntimeRecord): void {
  const temporary = `${config.runtimePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, config.runtimePath);
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

function defaultSpawnCore(config: LocalCoreConfig): ChildProcess {
  mkdirSync(config.stateDirectory, { recursive: true });
  const log = openSync(config.logPath, "a", 0o600);
  try {
    const child = spawn(process.execPath, [config.serverEntry], {
      cwd: config.repositoryRoot,
      detached: true,
      env: { ...process.env, CINBA_CORE_LIFETIME: "on-demand" },
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
): Promise<LocalCoreStatus> {
  const health = await probe(config.baseUrl);
  if (!health) {
    return { running: false, managed: false };
  }

  const runtime = readRuntime(config.runtimePath);
  const managed = Boolean(
    runtime && runtime.repositoryRoot === config.repositoryRoot && processIsAlive(runtime.pid),
  );
  return {
    running: true,
    managed,
    pid: managed ? runtime?.pid : undefined,
    health,
  };
}

/** Ensure the one shared local Core is healthy, starting it in the background when absent. */
export async function ensureLocalCore(
  options: EnsureLocalCoreOptions = {},
): Promise<LocalCoreStatus> {
  const config = options.config ?? createLocalCoreConfig();
  const probe = options.probe ?? probeCoreHealth;
  const existing = await inspectLocalCore(config, probe);
  if (existing.running) {
    return existing;
  }

  const release = await (options.acquireLock ?? acquireStartLock)(config.startLockPath);
  try {
    const foundInsideLock = await inspectLocalCore(config, probe);
    if (foundInsideLock.running) {
      return foundInsideLock;
    }

    mkdirSync(config.stateDirectory, { recursive: true });
    const child = (options.spawnCore ?? defaultSpawnCore)(config);
    if (child.pid === undefined) {
      throw new Error("The Cinba Core process did not report a PID");
    }
    const pid = child.pid;
    writeRuntime(config, {
      pid,
      repositoryRoot: config.repositoryRoot,
      startedAt: new Date().toISOString(),
    });

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
        return { running: true, managed: true, pid, health };
      }
      if (processError || child.exitCode !== null || child.signalCode !== null) {
        removeRuntime(config, pid);
        throw new Error(
          `The Cinba Core process exited before becoming ready${processError ? `: ${processError.message}` : ""}; see ${config.logPath}`,
        );
      }
      await delay(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    }

    removeRuntime(config, pid);
    throw new Error(
      `The Cinba Core did not become ready within ${readyTimeoutMs} milliseconds; see ${config.logPath}`,
    );
  } finally {
    release();
  }
}
