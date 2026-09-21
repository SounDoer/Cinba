import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

type SyncRuntimeRecord = {
  schemaVersion: 1;
  pid: number;
  startedAt: string;
};

type SyncControlRecord = {
  schemaVersion: 1;
  pid: number;
  token: string;
};

export type ManagedSyncControlConfig = {
  baseUrl: string;
  runtimePath: string;
  controlPath: string;
};

export type LocalSyncControlStatus = {
  status: "ok";
  pid: number;
  activeRequestCount: number;
  safeToStop: boolean;
  draining: boolean;
};
export type ManagedSyncStatus =
  | { running: false; managed: false }
  | { running: true; managed: false }
  | {
      running: true;
      managed: true;
      pid: number;
      activeRequestCount: number;
      safeToStop: boolean;
      draining: boolean;
    };

export type ManagedSyncHostStatus = {
  serverId: string;
  setupState: "setup-required" | "ready";
  settingsRevision: number;
  syncRevision: number;
  connectedCoreCount: number;
  pendingEnrollmentCount: number;
};

export type ManagedSyncHostBootstrapRequest = {
  enrollmentId: string;
  enrollmentSecret: string;
  settings: unknown;
};

export type ManagedSyncHostBootstrapResult = {
  serverId: string;
  coreId: string;
  settingsRevision: number;
  syncRevision: number;
};

type InspectManagedSyncOptions = {
  config: ManagedSyncControlConfig;
  probeHealth?: (baseUrl: string) => Promise<boolean>;
  processIsAlive?: (pid: number) => boolean;
  requestStatus?: (baseUrl: string, token: string) => Promise<LocalSyncControlStatus | undefined>;
};

export function createManagedSyncControlConfig(stateDirectory: string): ManagedSyncControlConfig {
  if (!isAbsolute(stateDirectory)) {
    throw new Error("Sync control state directory must be absolute");
  }
  return {
    baseUrl: "http://127.0.0.1:4518/",
    runtimePath: join(stateDirectory, "sync-runtime.json"),
    controlPath: join(stateDirectory, "sync-control.json"),
  };
}

async function readRuntime(path: string): Promise<SyncRuntimeRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<SyncRuntimeRecord>;
    return parsed.schemaVersion === 1 &&
      Number.isSafeInteger(parsed.pid) &&
      (parsed.pid ?? 0) > 0 &&
      typeof parsed.startedAt === "string"
      ? (parsed as SyncRuntimeRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

async function readControl(path: string): Promise<SyncControlRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<SyncControlRecord>;
    return parsed.schemaVersion === 1 &&
      Number.isSafeInteger(parsed.pid) &&
      (parsed.pid ?? 0) > 0 &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0
      ? (parsed as SyncControlRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function createManagedSyncControl(options: {
  config: ManagedSyncControlConfig;
  pid: number;
  token: string;
  now?: () => Date;
}): Promise<void> {
  if (!Number.isSafeInteger(options.pid) || options.pid < 1 || !options.token) {
    throw new Error("managed Sync control identity is invalid");
  }
  await writePrivateJson(options.config.runtimePath, {
    schemaVersion: 1,
    pid: options.pid,
    startedAt: (options.now ?? (() => new Date()))().toISOString(),
  } satisfies SyncRuntimeRecord);
  try {
    await writePrivateJson(options.config.controlPath, {
      schemaVersion: 1,
      pid: options.pid,
      token: options.token,
    } satisfies SyncControlRecord);
  } catch (error) {
    await removeManagedSyncControl(options.config, options.pid);
    throw error;
  }
}

export async function removeManagedSyncControl(
  config: ManagedSyncControlConfig,
  pid: number,
): Promise<void> {
  if ((await readControl(config.controlPath))?.pid === pid) {
    await rm(config.controlPath, { force: true });
  }
  if ((await readRuntime(config.runtimePath))?.pid === pid) {
    await rm(config.runtimePath, { force: true });
  }
}

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function defaultProbeHealth(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", baseUrl), {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      return false;
    }
    return ((await response.json()) as { status?: unknown }).status === "ok";
  } catch {
    return false;
  }
}

async function defaultRequestStatus(
  baseUrl: string,
  token: string,
): Promise<LocalSyncControlStatus | undefined> {
  try {
    const response = await fetch(new URL("/local-sync/status", baseUrl), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      return undefined;
    }
    const body = (await response.json()) as Record<string, unknown>;
    return body.status === "ok" &&
      Number.isSafeInteger(body.pid) &&
      Number.isSafeInteger(body.activeRequestCount) &&
      (body.activeRequestCount as number) >= 0 &&
      typeof body.safeToStop === "boolean" &&
      typeof body.draining === "boolean"
      ? {
          status: "ok",
          pid: body.pid as number,
          activeRequestCount: body.activeRequestCount as number,
          safeToStop: body.safeToStop,
          draining: body.draining,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

async function defaultRequestHostStatus(
  baseUrl: string,
  token: string,
): Promise<ManagedSyncHostStatus | undefined> {
  try {
    const response = await fetch(new URL("/local-sync/host-status", baseUrl), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      return undefined;
    }
    const body = (await response.json()) as Record<string, unknown>;
    const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
    return body.status === "ok" &&
      typeof body.serverId === "string" &&
      body.serverId.length > 0 &&
      body.serverId.length <= 512 &&
      (body.setupState === "setup-required" || body.setupState === "ready") &&
      count(body.settingsRevision) &&
      count(body.syncRevision) &&
      count(body.connectedCoreCount) &&
      count(body.pendingEnrollmentCount)
      ? {
          serverId: body.serverId,
          setupState: body.setupState,
          settingsRevision: body.settingsRevision as number,
          syncRevision: body.syncRevision as number,
          connectedCoreCount: body.connectedCoreCount as number,
          pendingEnrollmentCount: body.pendingEnrollmentCount as number,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

async function defaultRequestSetupCode(
  baseUrl: string,
  token: string,
): Promise<string | undefined | false> {
  try {
    const response = await fetch(new URL("/local-sync/setup-code", baseUrl), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (response.status === 409 && body.status === "setup-complete") {
      return undefined;
    }
    return response.ok &&
      body.status === "ok" &&
      typeof body.setupCode === "string" &&
      body.setupCode.length > 0 &&
      body.setupCode.length <= 512
      ? body.setupCode
      : false;
  } catch {
    return false;
  }
}

async function defaultRequestBootstrap(
  baseUrl: string,
  token: string,
  request: ManagedSyncHostBootstrapRequest,
): Promise<ManagedSyncHostBootstrapResult | undefined> {
  try {
    const response = await fetch(new URL("/local-sync/bootstrap", baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return undefined;
    }
    const body = (await response.json()) as Record<string, unknown>;
    const revision = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
    return body.status === "ok" &&
      typeof body.serverId === "string" &&
      body.serverId.length > 0 &&
      body.serverId.length <= 512 &&
      typeof body.coreId === "string" &&
      body.coreId.length > 0 &&
      body.coreId.length <= 512 &&
      revision(body.settingsRevision) &&
      revision(body.syncRevision)
      ? {
          serverId: body.serverId,
          coreId: body.coreId,
          settingsRevision: body.settingsRevision as number,
          syncRevision: body.syncRevision as number,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

async function ownedControl(options: InspectManagedSyncOptions): Promise<
  | {
      pid: number;
      token: string;
      activeRequestCount: number;
      safeToStop: boolean;
      draining: boolean;
    }
  | undefined
> {
  const runtime = await readRuntime(options.config.runtimePath);
  const control = await readControl(options.config.controlPath);
  if (
    !runtime ||
    !control ||
    runtime.pid !== control.pid ||
    !(options.processIsAlive ?? defaultProcessIsAlive)(runtime.pid)
  ) {
    return undefined;
  }
  const status = await (options.requestStatus ?? defaultRequestStatus)(
    options.config.baseUrl,
    control.token,
  );
  return status?.pid === runtime.pid
    ? {
        pid: runtime.pid,
        token: control.token,
        activeRequestCount: status.activeRequestCount,
        safeToStop: status.safeToStop,
        draining: status.draining,
      }
    : undefined;
}

export async function inspectManagedSyncControl(
  options: InspectManagedSyncOptions,
): Promise<ManagedSyncStatus> {
  if (!(await (options.probeHealth ?? defaultProbeHealth)(options.config.baseUrl))) {
    return { running: false, managed: false };
  }
  const owned = await ownedControl(options);
  return owned
    ? {
        running: true,
        managed: true,
        pid: owned.pid,
        activeRequestCount: owned.activeRequestCount,
        safeToStop: owned.safeToStop,
        draining: owned.draining,
      }
    : { running: true, managed: false };
}

export async function inspectManagedSyncHost(
  options: InspectManagedSyncOptions & {
    requestHostStatus?: (
      baseUrl: string,
      token: string,
    ) => Promise<ManagedSyncHostStatus | undefined>;
  },
): Promise<ManagedSyncHostStatus> {
  const owned = await ownedControl(options);
  if (!owned) {
    throw new Error("the running local Sync is not owned by this manager");
  }
  const status = await (options.requestHostStatus ?? defaultRequestHostStatus)(
    options.config.baseUrl,
    owned.token,
  );
  if (!status) {
    throw new Error("Cinba Sync returned an invalid local Host status");
  }
  return status;
}

export async function readManagedSyncSetupCode(
  options: InspectManagedSyncOptions & {
    requestSetupCode?: (baseUrl: string, token: string) => Promise<string | undefined | false>;
  },
): Promise<string | undefined> {
  const owned = await ownedControl(options);
  if (!owned) {
    throw new Error("the running local Sync is not owned by this manager");
  }
  const setupCode = await (options.requestSetupCode ?? defaultRequestSetupCode)(
    options.config.baseUrl,
    owned.token,
  );
  if (setupCode === false) {
    throw new Error("Cinba Sync refused the local Setup Code request");
  }
  return setupCode;
}

export async function bootstrapManagedSyncHost(
  options: InspectManagedSyncOptions & {
    request: ManagedSyncHostBootstrapRequest;
    requestBootstrap?: (
      baseUrl: string,
      token: string,
      request: ManagedSyncHostBootstrapRequest,
    ) => Promise<ManagedSyncHostBootstrapResult | undefined>;
  },
): Promise<ManagedSyncHostBootstrapResult> {
  const owned = await ownedControl(options);
  if (!owned) {
    throw new Error("the running local Sync is not owned by this manager");
  }
  const result = await (options.requestBootstrap ?? defaultRequestBootstrap)(
    options.config.baseUrl,
    owned.token,
    options.request,
  );
  if (!result) {
    throw new Error("Cinba Sync refused the local Host bootstrap request");
  }
  return result;
}

async function defaultRequestStop(
  baseUrl: string,
  token: string,
): Promise<"accepted" | "busy" | "refused"> {
  try {
    const response = await fetch(new URL("/local-sync/stop", baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    });
    const status = ((await response.json()) as { status?: unknown }).status;
    if (response.status === 409 && status === "busy") {
      return "busy";
    }
    return response.ok && status === "accepted" ? "accepted" : "refused";
  } catch {
    return "refused";
  }
}

export async function waitForManagedSyncExit(options: {
  config: ManagedSyncControlConfig;
  probeHealth?: (baseUrl: string) => Promise<boolean>;
  delay?: (milliseconds: number) => Promise<void>;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<void> {
  const delay =
    options.delay ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + (options.waitTimeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    const healthy = await (options.probeHealth ?? defaultProbeHealth)(options.config.baseUrl);
    const runtime = await readRuntime(options.config.runtimePath);
    const control = await readControl(options.config.controlPath);
    if (!healthy && !runtime && !control) {
      return;
    }
    await delay(options.pollIntervalMs ?? 100);
  }
  throw new Error("Cinba Sync did not exit before the timeout");
}

export async function stopManagedSyncControl(
  options: InspectManagedSyncOptions & {
    requestStop?: (
      baseUrl: string,
      token: string,
    ) => Promise<boolean | "accepted" | "busy" | "refused">;
    delay?: (milliseconds: number) => Promise<void>;
    waitTimeoutMs?: number;
    pollIntervalMs?: number;
  },
): Promise<void> {
  const running = await (options.probeHealth ?? defaultProbeHealth)(options.config.baseUrl);
  const owned = running ? await ownedControl(options) : undefined;
  if (!running || !owned) {
    throw new Error("the running local Sync is not owned by this manager");
  }
  if (!owned.safeToStop || owned.activeRequestCount > 0 || owned.draining) {
    throw new Error("Cinba Sync has active requests and is not safe to stop");
  }
  const stopResult = await (options.requestStop ?? defaultRequestStop)(
    options.config.baseUrl,
    owned.token,
  );
  if (stopResult === "busy") {
    throw new Error("Cinba Sync became busy before the graceful stop could begin");
  }
  if (stopResult !== true && stopResult !== "accepted") {
    throw new Error("the running local Sync refused the graceful stop request");
  }

  await waitForManagedSyncExit(options);
}
