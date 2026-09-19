import { acquireInstallationLock } from "../installation-lock.ts";
import type { InstallationLayout } from "../installation-store.ts";
import type { ManagedServiceDefinition } from "./definitions.ts";
import {
  type ServiceComponentRecord,
  type ServiceFailure,
  type ServiceMode,
  type ServiceState,
  createDefaultServiceState,
  readServiceState,
  writeServiceState,
} from "./service-state.ts";

export type PlatformServiceSnapshot = {
  registered: boolean;
  running: boolean;
  /** Why this host cannot run Background at all; nothing can be registered then. */
  backgroundUnavailable?: string;
};

export type PlatformServiceAdapter = {
  inspect(definition: ManagedServiceDefinition): Promise<PlatformServiceSnapshot>;
  /** Checks, and where the user consents, satisfies Background prerequisites before any change. */
  prepareBackground?(definition: ManagedServiceDefinition): Promise<void>;
  install(definition: ManagedServiceDefinition): Promise<void>;
  remove(definition: ManagedServiceDefinition): Promise<void>;
  start(definition: ManagedServiceDefinition): Promise<void>;
  stop(definition: ManagedServiceDefinition): Promise<void>;
};

export type ManagedServiceStatus =
  | { component: ManagedServiceDefinition["component"]; state: "not-installed" }
  | { component: ManagedServiceDefinition["component"]; state: "not-created" }
  | {
      component: ManagedServiceDefinition["component"];
      state: ServiceMode | "unknown";
      desiredMode: ServiceMode;
      phase: ServiceComponentRecord["phase"];
      failure: ServiceFailure | null;
      registered: boolean;
      running: boolean;
      healthy: boolean | null;
      backgroundUnavailable?: string;
    };

export type ServiceAvailability = { productInstalled: boolean; componentCreated: boolean };

const PLATFORM_SETTLE_TIMEOUT_MS = 5_000;
const PLATFORM_SETTLE_INTERVAL_MS = 50;

export type ServiceManagerOptions = {
  layout: InstallationLayout;
  serviceStateDirectory: string;
  definition: ManagedServiceDefinition;
  adapter: PlatformServiceAdapter;
  availability: ServiceAvailability;
  verifyHealth?: (definition: ManagedServiceDefinition) => Promise<void>;
  now?: () => Date;
  /** The caller already holds the installation lock (the uninstall helper), so do not take it. */
  installationLockHeld?: boolean;
};

async function waitForPlatform(
  adapter: PlatformServiceAdapter,
  definition: ManagedServiceDefinition,
  settled: (snapshot: PlatformServiceSnapshot) => boolean,
): Promise<PlatformServiceSnapshot> {
  const deadline = Date.now() + PLATFORM_SETTLE_TIMEOUT_MS;
  let snapshot = await adapter.inspect(definition);
  while (!settled(snapshot) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, PLATFORM_SETTLE_INTERVAL_MS));
    snapshot = await adapter.inspect(definition);
  }
  return snapshot;
}

async function waitForHealth(
  verifyHealth: (definition: ManagedServiceDefinition) => Promise<void>,
  definition: ManagedServiceDefinition,
): Promise<void> {
  const deadline = Date.now() + PLATFORM_SETTLE_TIMEOUT_MS;
  while (true) {
    try {
      await verifyHealth(definition);
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, PLATFORM_SETTLE_INTERVAL_MS));
    }
  }
}

async function defaultVerifyHealth(definition: ManagedServiceDefinition): Promise<void> {
  const response = await fetch(definition.healthUrl, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) {
    throw new Error(`${definition.displayName} health check failed`);
  }
  const body = (await response.json()) as { status?: unknown };
  if (body.status !== "ok") {
    throw new Error(`${definition.displayName} health identity is invalid`);
  }
}

function recordFor(
  state: ServiceState,
  definition: ManagedServiceDefinition,
): ServiceComponentRecord {
  return state[definition.component];
}

function replaceRecord(
  state: ServiceState,
  definition: ManagedServiceDefinition,
  next: ServiceComponentRecord,
): ServiceState {
  return { ...state, [definition.component]: next };
}

function updateRecord(
  previous: ServiceComponentRecord,
  values: Partial<ServiceComponentRecord>,
  now: () => Date,
): ServiceComponentRecord {
  return { ...previous, ...values, updatedAt: now().toISOString() };
}

async function platformMatches(
  mode: ServiceMode,
  snapshot: PlatformServiceSnapshot,
  definition: ManagedServiceDefinition,
  verifyHealth: (definition: ManagedServiceDefinition) => Promise<void>,
): Promise<boolean> {
  if (mode !== "background") {
    return !snapshot.registered;
  }
  if (!snapshot.registered || !snapshot.running) {
    return false;
  }
  try {
    await verifyHealth(definition);
    return true;
  } catch {
    return false;
  }
}

async function applyPlatformMode(
  mode: ServiceMode,
  definition: ManagedServiceDefinition,
  adapter: PlatformServiceAdapter,
  verifyHealth: (definition: ManagedServiceDefinition) => Promise<void>,
  setFailure: (failure: ServiceFailure) => void,
): Promise<void> {
  let snapshot = await adapter.inspect(definition);
  if (mode === "background") {
    if (!snapshot.registered) {
      setFailure("registration-failed");
      await adapter.install(definition);
      snapshot = await waitForPlatform(adapter, definition, (current) => current.registered);
      if (!snapshot.registered) {
        throw new Error(`${definition.displayName} registration was not installed`);
      }
    }
    if (!snapshot.running) {
      setFailure("start-failed");
      await adapter.start(definition);
      snapshot = await waitForPlatform(adapter, definition, (current) => current.running);
      if (!snapshot.running) {
        throw new Error(`${definition.displayName} did not start`);
      }
    }
    setFailure("health-failed");
    await waitForHealth(verifyHealth, definition);
    return;
  }
  if (snapshot.running) {
    setFailure("stop-failed");
    await adapter.stop(definition);
    snapshot = await waitForPlatform(adapter, definition, (current) => !current.running);
    if (snapshot.running) {
      throw new Error(`${definition.displayName} did not stop`);
    }
  }
  if (snapshot.registered) {
    setFailure("removal-failed");
    await adapter.remove(definition);
    snapshot = await waitForPlatform(adapter, definition, (current) => !current.registered);
    if (snapshot.registered) {
      throw new Error(`${definition.displayName} registration was not removed`);
    }
  }
}

export async function inspectManagedService(
  options: ServiceManagerOptions,
): Promise<ManagedServiceStatus> {
  const component = options.definition.component;
  if (!options.availability.productInstalled) {
    return { component, state: "not-installed" };
  }
  if (!options.availability.componentCreated) {
    return { component, state: "not-created" };
  }
  const state =
    (await readServiceState(options.serviceStateDirectory)) ??
    createDefaultServiceState(options.now?.());
  const service = recordFor(state, options.definition);
  const platform = await options.adapter.inspect(options.definition);
  let healthy: boolean | null = null;
  if (platform.running) {
    try {
      await (options.verifyHealth ?? defaultVerifyHealth)(options.definition);
      healthy = true;
    } catch {
      healthy = false;
    }
  }
  return {
    component,
    state: service.mode ?? "unknown",
    desiredMode: service.desiredMode,
    phase: service.phase,
    failure: service.failure,
    registered: platform.registered,
    running: platform.running,
    healthy,
    ...(platform.backgroundUnavailable
      ? { backgroundUnavailable: platform.backgroundUnavailable }
      : {}),
  };
}

export async function setManagedServiceMode(
  options: ServiceManagerOptions,
  desiredMode: ServiceMode,
): Promise<ManagedServiceStatus> {
  if (!options.availability.productInstalled) {
    throw new Error("Cinba is not installed");
  }
  if (!options.availability.componentCreated) {
    throw new Error(`${options.definition.displayName} has not been created`);
  }
  if (!options.definition.allowedModes.includes(desiredMode)) {
    throw new Error(`${options.definition.displayName} does not support ${desiredMode}`);
  }
  const unlock = options.installationLockHeld
    ? async () => undefined
    : await acquireInstallationLock(options.layout);
  const now = options.now ?? (() => new Date());
  const verifyHealth = options.verifyHealth ?? defaultVerifyHealth;
  try {
    let state =
      (await readServiceState(options.serviceStateDirectory)) ?? createDefaultServiceState(now());
    const previous = recordFor(state, options.definition);
    const platform = await options.adapter.inspect(options.definition);
    if (
      previous.phase === "stable" &&
      previous.mode === desiredMode &&
      (await platformMatches(desiredMode, platform, options.definition, verifyHealth))
    ) {
      return await inspectManagedService(options);
    }
    // A missing prerequisite refuses the change before any state records an attempt.
    if (desiredMode === "background") {
      await options.adapter.prepareBackground?.(options.definition);
    }

    state = replaceRecord(
      state,
      options.definition,
      updateRecord(previous, { desiredMode, phase: "applying", failure: null }, now),
    );
    await writeServiceState(options.serviceStateDirectory, state);
    let failure: ServiceFailure = "registration-failed";
    try {
      await applyPlatformMode(
        desiredMode,
        options.definition,
        options.adapter,
        verifyHealth,
        (next) => {
          failure = next;
        },
      );
      state = replaceRecord(
        state,
        options.definition,
        updateRecord(
          recordFor(state, options.definition),
          { mode: desiredMode, desiredMode, phase: "stable", failure: null },
          now,
        ),
      );
      await writeServiceState(options.serviceStateDirectory, state);
      return await inspectManagedService(options);
    } catch (applyError) {
      let restoredMode = previous.mode;
      let recordedFailure: ServiceFailure = failure;
      try {
        if (previous.mode) {
          await applyPlatformMode(
            previous.mode,
            options.definition,
            options.adapter,
            verifyHealth,
            () => undefined,
          );
        }
      } catch {
        restoredMode = null;
        recordedFailure = "recovery-failed";
      }
      state = replaceRecord(
        state,
        options.definition,
        updateRecord(
          recordFor(state, options.definition),
          { mode: restoredMode, desiredMode, phase: "failed", failure: recordedFailure },
          now,
        ),
      );
      await writeServiceState(options.serviceStateDirectory, state);
      const reason = applyError instanceof Error ? applyError.message : String(applyError);
      throw new Error(
        `could not set ${options.definition.displayName} to ${desiredMode}: ${reason}`,
        { cause: applyError },
      );
    }
  } finally {
    await unlock();
  }
}

export async function recoverManagedServiceOperation(
  options: ServiceManagerOptions,
): Promise<ManagedServiceStatus> {
  const state = await readServiceState(options.serviceStateDirectory);
  const current = state && recordFor(state, options.definition);
  if (!current || current.phase !== "applying") {
    return await inspectManagedService(options);
  }
  return await setManagedServiceMode(options, current.desiredMode);
}
