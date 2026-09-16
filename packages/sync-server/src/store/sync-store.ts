import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  type CapabilitiesReport,
  type ConnectedCoreList,
  type CredentialStatus,
  type EnrollmentCreated,
  type EnrollmentRequest,
  type EnrollmentStatus,
  type ModelCatalog,
  type PendingEnrollmentList,
  type SharedSettings,
  type SharedSettingsView,
  type SyncSnapshot,
  parseSharedSettings,
} from "@cinba/sync-contract";
import {
  decryptCredential,
  encryptCredential,
  generateCredentialKey,
  hashSecret,
  verifySecret,
} from "../security/credentials.ts";
import {
  type AtomicWriteOptions,
  replaceJsonAtomically,
  writePrivateFileOnce,
} from "./atomic-json-store.ts";
import { type SyncState, parseSyncState } from "./schema.ts";

export class SyncStoreUnavailableError extends Error {
  constructor() {
    super(
      "Sync Store is read-only because state.json and credential-key could not be verified together",
    );
    this.name = "SyncStoreUnavailableError";
  }
}

export class SyncMaintenanceError extends Error {
  constructor() {
    super("Sync Server is in read-only maintenance mode");
    this.name = "SyncMaintenanceError";
  }
}

export class SettingsConflictError extends Error {
  readonly currentSettingsRevision: number;

  constructor(currentSettingsRevision: number) {
    super("Shared Settings changed after the requested base revision");
    this.name = "SettingsConflictError";
    this.currentSettingsRevision = currentSettingsRevision;
  }
}

export class CoreAuthenticationError extends Error {
  constructor() {
    super("Core credential is invalid or revoked");
    this.name = "CoreAuthenticationError";
  }
}

export class EnrollmentAuthenticationError extends Error {
  constructor() {
    super("Enrollment credential is invalid");
    this.name = "EnrollmentAuthenticationError";
  }
}

export type SyncStoreOptions = {
  now?: () => Date;
  atomicWrite?: AtomicWriteOptions;
  readOnly?: () => boolean;
};

export type SyncStore = {
  problem(): SyncStoreUnavailableError | undefined;
  serverId(): string;
  settings(): SharedSettingsView;
  credentialStatuses(): CredentialStatus[];
  credential(provider: string): string | undefined;
  snapshot(includeCredentials: boolean): SyncSnapshot;
  history(): SyncState["history"];
  pendingEnrollments(): PendingEnrollmentList;
  connectedCores(): ConnectedCoreList;
  modelCatalog(): ModelCatalog;
  createEnrollment(request: EnrollmentRequest): Promise<EnrollmentCreated>;
  enrollmentStatus(enrollmentId: string, secret: string): Promise<EnrollmentStatus>;
  decideEnrollment(enrollmentId: string, decision: "approve" | "reject"): Promise<void>;
  reportCapabilities(coreCredential: string, report: CapabilitiesReport): Promise<void>;
  snapshotForCore(coreCredential: string): Promise<SyncSnapshot>;
  updateCoreCredentialSource(
    coreCredential: string,
    credentialSource: "local" | "sync",
  ): Promise<void>;
  revokeCore(coreId: string): Promise<void>;
  authenticationState(): "setup-required" | "ready";
  authenticationMarker(): string;
  localSetupCode(): string | undefined;
  verifyAdministratorPassword(password: string): boolean;
  completeAdministratorSetup(setupCode: string, password: string): Promise<boolean>;
  resetAdministrator(): Promise<string>;
  updateSettings(
    baseSettingsRevision: number,
    settings: SharedSettings,
  ): Promise<SharedSettingsView>;
  rollbackSettings(
    baseSettingsRevision: number,
    targetSettingsRevision: number,
  ): Promise<SharedSettingsView>;
  setCredential(provider: string, credential: string | undefined): Promise<number>;
};

function newSetupCode(): string {
  return randomBytes(24).toString("base64url");
}

function initialState(now: Date, key: Uint8Array): SyncState {
  const settings: SharedSettings = {
    version: 1,
    webTools: { searchPrimary: "auto" },
  };
  const setupCode = newSetupCode();
  return {
    version: 1,
    serverId: randomUUID(),
    settings,
    settingsRevision: 0,
    syncRevision: 0,
    history: [
      {
        settingsRevision: 0,
        syncRevision: 0,
        createdAt: now.toISOString(),
        settings,
      },
    ],
    credentials: {},
    cores: [],
    enrollments: [],
    setupCode: hashSecret(setupCode),
    setupCodeDisplay: encryptCredential(setupCode, key),
  };
}

function cloneState(state: SyncState): SyncState {
  return structuredClone(state);
}

function validateProvider(provider: string): string {
  const trimmed = provider.trim();
  if (trimmed === "" || trimmed.length > 128) {
    throw new Error("Provider id must be a non-empty string up to 128 characters");
  }
  return trimmed;
}

function coreCredential(coreId: string): string {
  return `${coreId}.${randomBytes(32).toString("base64url")}`;
}

export function createSyncStore(directory: string, options: SyncStoreOptions = {}): SyncStore {
  const statePath = join(directory, "state.json");
  const keyPath = join(directory, "credential-key");
  const now = options.now ?? (() => new Date());
  let key: Buffer | undefined;
  let state: SyncState | undefined;
  let stateContents: string | undefined;
  let loadProblem: SyncStoreUnavailableError | undefined;
  let createdKey = false;

  try {
    const stateExists = existsSync(statePath);
    const keyExists = existsSync(keyPath);
    if (!stateExists && !keyExists) {
      key = generateCredentialKey();
      state = initialState(now(), key);
      writePrivateFileOnce(keyPath, key);
      createdKey = true;
      replaceJsonAtomically(statePath, state, parseSyncState, options.atomicWrite);
      stateContents = readFileSync(statePath, "utf8");
    } else if (!stateExists || !keyExists) {
      throw new Error("state.json and credential-key must exist together");
    } else {
      key = readFileSync(keyPath);
      if (key.byteLength !== 32) {
        throw new Error("credential-key has an invalid length");
      }
      stateContents = readFileSync(statePath, "utf8");
      state = parseSyncState(JSON.parse(stateContents) as unknown);
      for (const envelope of Object.values(state.credentials)) {
        decryptCredential(envelope, key);
      }
      if (state.setupCodeDisplay) {
        decryptCredential(state.setupCodeDisplay, key);
      }
      for (const enrollment of state.enrollments) {
        if (enrollment.credentialDelivery) {
          decryptCredential(enrollment.credentialDelivery, key);
        }
      }
    }
  } catch {
    if (createdKey && !existsSync(statePath)) {
      try {
        unlinkSync(keyPath);
      } catch {
        // A failed cleanup still remains fail-closed on the next start.
      }
    }
    key = undefined;
    state = undefined;
    loadProblem = new SyncStoreUnavailableError();
  }

  let mutationTail: Promise<void> = Promise.resolve();

  function requireState(): { state: SyncState; key: Buffer } {
    if (!state || !key || loadProblem) {
      throw loadProblem ?? new SyncStoreUnavailableError();
    }
    const diskContents = readFileSync(statePath, "utf8");
    if (diskContents !== stateContents) {
      const diskKey = readFileSync(keyPath);
      if (diskKey.byteLength !== 32) {
        throw new SyncStoreUnavailableError();
      }
      const diskState = parseSyncState(JSON.parse(diskContents) as unknown);
      for (const envelope of Object.values(diskState.credentials)) {
        decryptCredential(envelope, diskKey);
      }
      if (diskState.setupCodeDisplay) {
        decryptCredential(diskState.setupCodeDisplay, diskKey);
      }
      for (const enrollment of diskState.enrollments) {
        if (enrollment.credentialDelivery) {
          decryptCredential(enrollment.credentialDelivery, diskKey);
        }
      }
      key = diskKey;
      state = diskState;
      stateContents = diskContents;
    }
    return { state, key };
  }

  function commit(next: SyncState): void {
    parseSyncState(next);
    replaceJsonAtomically(statePath, next, parseSyncState, options.atomicWrite);
    state = next;
    stateContents = readFileSync(statePath, "utf8");
  }

  function enqueue<T>(mutation: () => T): Promise<T> {
    const result = mutationTail.then(() => {
      if (options.readOnly?.()) {
        throw new SyncMaintenanceError();
      }
      return mutation();
    });
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function settingsView(current: SyncState): SharedSettingsView {
    return {
      version: 1,
      settingsRevision: current.settingsRevision,
      syncRevision: current.syncRevision,
      settings: structuredClone(current.settings),
    };
  }

  function authenticateCore(current: SyncState, credential: string) {
    const separator = credential.indexOf(".");
    const coreId = separator > 0 ? credential.slice(0, separator) : "";
    const core = current.cores.find((candidate) => candidate.id === coreId);
    if (!core || core.revokedAt || !verifySecret(credential, core.tokenHash)) {
      throw new CoreAuthenticationError();
    }
    return core;
  }

  function connectedCores(current: SyncState): ConnectedCoreList {
    return {
      version: 1,
      cores: current.cores.map((core) => ({
        version: 1,
        id: core.id,
        name: core.name,
        platform: core.platform,
        appVersion: core.appVersion,
        credentialSource: core.credentialSource,
        revoked: core.revokedAt !== undefined,
        ...(core.lastSeenAt ? { lastSeenAt: core.lastSeenAt } : {}),
        ...(core.lastSyncRevision === undefined ? {} : { lastSyncRevision: core.lastSyncRevision }),
        ...(core.lastSyncErrorCode ? { lastSyncErrorCode: core.lastSyncErrorCode } : {}),
      })),
    };
  }

  return {
    problem: () => loadProblem,
    serverId: () => requireState().state.serverId,
    settings: () => settingsView(requireState().state),
    credentialStatuses: () =>
      Object.keys(requireState().state.credentials)
        .toSorted()
        .map((provider) => ({ version: 1, provider, configured: true })),
    credential: (provider) => {
      const current = requireState();
      const envelope = current.state.credentials[provider];
      return envelope ? decryptCredential(envelope, current.key) : undefined;
    },
    snapshot: (includeCredentials) => {
      const current = requireState();
      const credentials = includeCredentials
        ? Object.fromEntries(
            Object.entries(current.state.credentials).map(([provider, envelope]) => [
              provider,
              decryptCredential(envelope, current.key),
            ]),
          )
        : undefined;
      return {
        version: 1,
        syncRevision: current.state.syncRevision,
        settingsRevision: current.state.settingsRevision,
        settings: structuredClone(current.state.settings),
        ...(credentials ? { credentials } : {}),
      };
    },
    history: () => structuredClone(requireState().state.history),
    pendingEnrollments: () => {
      const current = requireState().state;
      const currentTime = now().getTime();
      return {
        version: 1,
        enrollments: current.enrollments
          .filter(
            (enrollment) =>
              enrollment.status === "pending" &&
              new Date(enrollment.expiresAt).getTime() > currentTime,
          )
          .map((enrollment) => ({
            version: 1,
            id: enrollment.id,
            name: enrollment.name,
            platform: enrollment.platform,
            appVersion: enrollment.appVersion,
            credentialSource: enrollment.credentialSource,
            createdAt: enrollment.createdAt,
            expiresAt: enrollment.expiresAt,
          })),
      };
    },
    connectedCores: () => connectedCores(requireState().state),
    modelCatalog: () => {
      const cores = requireState().state.cores.filter((core) => !core.revokedAt);
      const coreIds = cores.map((core) => core.id);
      const models = new Map<string, { provider: string; id: string }>();
      for (const core of cores) {
        for (const model of core.capabilities?.models ?? []) {
          models.set(`${model.provider}\u0000${model.id}`, model);
        }
      }
      return {
        version: 1,
        models: [...models.values()]
          .toSorted((left, right) =>
            `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`),
          )
          .map((model) => {
            const supportedCoreIds = cores
              .filter((core) =>
                (core.capabilities?.models ?? []).some(
                  (candidate) => candidate.provider === model.provider && candidate.id === model.id,
                ),
              )
              .map((core) => core.id);
            return {
              model: { ...model },
              supportedCoreIds,
              unsupportedCoreIds: coreIds.filter((id) => !supportedCoreIds.includes(id)),
            };
          }),
      };
    },
    createEnrollment: (request) =>
      enqueue(() => {
        const current = requireState();
        const id = randomUUID();
        const secret = randomBytes(32).toString("base64url");
        const createdAt = now();
        const expiresAt = new Date(createdAt.getTime() + 10 * 60_000);
        const next = cloneState(current.state);
        next.enrollments.push({
          id,
          name: request.name,
          platform: request.platform,
          appVersion: request.appVersion,
          credentialSource: request.credentialSource,
          createdAt: createdAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          secretHash: hashSecret(secret),
          status: "pending",
        });
        commit(next);
        return {
          version: 1,
          enrollmentId: id,
          enrollmentSecret: secret,
          expiresAt: expiresAt.toISOString(),
        };
      }),
    enrollmentStatus: (enrollmentId, secret) =>
      enqueue(() => {
        const current = requireState();
        const enrollment = current.state.enrollments.find(
          (candidate) => candidate.id === enrollmentId,
        );
        if (!enrollment || !verifySecret(secret, enrollment.secretHash)) {
          throw new EnrollmentAuthenticationError();
        }
        if (new Date(enrollment.expiresAt).getTime() <= now().getTime()) {
          const next = cloneState(current.state);
          next.enrollments = next.enrollments.filter((candidate) => candidate.id !== enrollmentId);
          commit(next);
          return { version: 1, status: "expired" };
        }
        if (enrollment.status === "pending") {
          return { version: 1, status: "pending" };
        }
        const next = cloneState(current.state);
        next.enrollments = next.enrollments.filter((candidate) => candidate.id !== enrollmentId);
        if (enrollment.status === "rejected") {
          commit(next);
          return { version: 1, status: "rejected" };
        }
        const credential = decryptCredential(enrollment.credentialDelivery!, current.key);
        commit(next);
        return {
          version: 1,
          status: "approved",
          coreId: enrollment.coreId!,
          coreCredential: credential,
        };
      }),
    decideEnrollment: (enrollmentId, decision) =>
      enqueue(() => {
        const current = requireState();
        const index = current.state.enrollments.findIndex(
          (candidate) => candidate.id === enrollmentId,
        );
        const enrollment = current.state.enrollments[index];
        if (
          !enrollment ||
          enrollment.status !== "pending" ||
          new Date(enrollment.expiresAt).getTime() <= now().getTime()
        ) {
          throw new Error("Pending enrollment does not exist");
        }
        const next = cloneState(current.state);
        const nextEnrollment = next.enrollments[index]!;
        if (decision === "reject") {
          nextEnrollment.status = "rejected";
          commit(next);
          return;
        }
        const coreId = randomUUID();
        const credential = coreCredential(coreId);
        next.cores.push({
          id: coreId,
          name: enrollment.name,
          platform: enrollment.platform,
          appVersion: enrollment.appVersion,
          credentialSource: enrollment.credentialSource,
          createdAt: now().toISOString(),
          tokenHash: hashSecret(credential),
        });
        nextEnrollment.status = "approved";
        nextEnrollment.coreId = coreId;
        nextEnrollment.credentialDelivery = encryptCredential(credential, current.key);
        commit(next);
      }),
    reportCapabilities: (credential, report) =>
      enqueue(() => {
        const current = requireState();
        const core = authenticateCore(current.state, credential);
        const next = cloneState(current.state);
        const target = next.cores.find((candidate) => candidate.id === core.id)!;
        target.appVersion = report.appVersion;
        target.capabilities = structuredClone(report.capabilities);
        target.lastSeenAt = now().toISOString();
        if (report.currentSyncRevision !== undefined) {
          target.lastSyncRevision = report.currentSyncRevision;
        }
        if (report.lastSyncErrorCode === undefined) {
          delete target.lastSyncErrorCode;
        } else {
          target.lastSyncErrorCode = report.lastSyncErrorCode;
        }
        commit(next);
      }),
    snapshotForCore: (credential) =>
      enqueue(() => {
        const current = requireState();
        const core = authenticateCore(current.state, credential);
        const next = cloneState(current.state);
        const target = next.cores.find((candidate) => candidate.id === core.id)!;
        target.lastSeenAt = now().toISOString();
        target.lastSyncRevision = current.state.syncRevision;
        commit(next);
        const credentials =
          core.credentialSource === "sync"
            ? Object.fromEntries(
                Object.entries(current.state.credentials).map(([provider, envelope]) => [
                  provider,
                  decryptCredential(envelope, current.key),
                ]),
              )
            : undefined;
        return {
          version: 1,
          syncRevision: current.state.syncRevision,
          settingsRevision: current.state.settingsRevision,
          settings: structuredClone(current.state.settings),
          ...(credentials ? { credentials } : {}),
        };
      }),
    updateCoreCredentialSource: (credential, credentialSource) =>
      enqueue(() => {
        const current = requireState();
        const core = authenticateCore(current.state, credential);
        const next = cloneState(current.state);
        const target = next.cores.find((candidate) => candidate.id === core.id)!;
        target.credentialSource = credentialSource;
        target.lastSeenAt = now().toISOString();
        commit(next);
      }),
    revokeCore: (coreId) =>
      enqueue(() => {
        const current = requireState().state;
        const next = cloneState(current);
        const core = next.cores.find((candidate) => candidate.id === coreId);
        if (!core || core.revokedAt) {
          throw new Error("Connected Core does not exist or is already revoked");
        }
        core.revokedAt = now().toISOString();
        commit(next);
      }),
    authenticationState: () => (requireState().state.administrator ? "ready" : "setup-required"),
    authenticationMarker: () => {
      const current = requireState().state;
      return `${current.serverId}:${current.administrator?.digest ?? current.setupCode?.digest ?? "missing"}`;
    },
    localSetupCode: () => {
      const current = requireState();
      return current.state.setupCodeDisplay
        ? decryptCredential(current.state.setupCodeDisplay, current.key)
        : undefined;
    },
    verifyAdministratorPassword: (password) => {
      const administrator = requireState().state.administrator;
      return administrator ? verifySecret(password, administrator) : false;
    },
    completeAdministratorSetup: (setupCode, password) =>
      enqueue(() => {
        const current = requireState();
        if (!current.state.setupCode || !verifySecret(setupCode, current.state.setupCode)) {
          return false;
        }
        const next = cloneState(current.state);
        next.administrator = hashSecret(password);
        delete next.setupCode;
        delete next.setupCodeDisplay;
        commit(next);
        return true;
      }),
    resetAdministrator: () =>
      enqueue(() => {
        const current = requireState();
        const setupCode = newSetupCode();
        const next = cloneState(current.state);
        delete next.administrator;
        next.setupCode = hashSecret(setupCode);
        next.setupCodeDisplay = encryptCredential(setupCode, current.key);
        commit(next);
        return setupCode;
      }),
    updateSettings: (baseSettingsRevision, nextSettings) =>
      enqueue(() => {
        const current = requireState().state;
        if (current.settingsRevision !== baseSettingsRevision) {
          throw new SettingsConflictError(current.settingsRevision);
        }
        const settings = parseSharedSettings(nextSettings);
        const next = cloneState(current);
        next.settingsRevision += 1;
        next.syncRevision += 1;
        next.settings = settings;
        next.history.push({
          settingsRevision: next.settingsRevision,
          syncRevision: next.syncRevision,
          createdAt: now().toISOString(),
          settings: structuredClone(settings),
        });
        commit(next);
        return settingsView(next);
      }),
    rollbackSettings: (baseSettingsRevision, targetSettingsRevision) =>
      enqueue(() => {
        const current = requireState().state;
        if (current.settingsRevision !== baseSettingsRevision) {
          throw new SettingsConflictError(current.settingsRevision);
        }
        const target = current.history.find(
          (entry) => entry.settingsRevision === targetSettingsRevision,
        );
        if (!target) {
          throw new Error("Target Settings revision does not exist");
        }
        const next = cloneState(current);
        next.settingsRevision += 1;
        next.syncRevision += 1;
        next.settings = structuredClone(target.settings);
        next.history.push({
          settingsRevision: next.settingsRevision,
          syncRevision: next.syncRevision,
          createdAt: now().toISOString(),
          settings: structuredClone(next.settings),
        });
        commit(next);
        return settingsView(next);
      }),
    setCredential: (provider, credential) =>
      enqueue(() => {
        const current = requireState();
        const providerId = validateProvider(provider);
        if (credential !== undefined && credential === "") {
          throw new Error("Credential must not be empty");
        }
        const next = cloneState(current.state);
        if (credential === undefined) {
          delete next.credentials[providerId];
        } else {
          next.credentials[providerId] = encryptCredential(credential, current.key);
        }
        next.syncRevision += 1;
        commit(next);
        return next.syncRevision;
      }),
  };
}
