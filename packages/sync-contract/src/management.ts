import {
  type ModelRef,
  arrayAt,
  booleanAt,
  integerAt,
  modelRefAt,
  oneOf,
  optionalStringAt,
  strictObject,
  stringAt,
  versionOne,
} from "./schemas.ts";

export type SharedSettings = {
  version: 1;
  defaultModel?: ModelRef;
  webTools: { searchPrimary: "auto" | "exa" | "brave" };
};

export type SharedSettingsView = {
  version: 1;
  settingsRevision: number;
  syncRevision: number;
  settings: SharedSettings;
};

export type UpdateSharedSettingsRequest = {
  version: 1;
  baseSettingsRevision: number;
  settings: SharedSettings;
};

export type CredentialStatus = {
  version: 1;
  provider: string;
  configured: boolean;
};

export type CredentialStatusList = {
  version: 1;
  credentials: CredentialStatus[];
  syncRevision: number;
};

export type PutCredentialRequest = { version: 1; apiKey: string };

export type ConnectedCore = {
  version: 1;
  id: string;
  name: string;
  platform: "windows" | "macos" | "linux" | "other";
  appVersion: string;
  credentialSource: "local" | "sync";
  revoked: boolean;
  lastSeenAt?: string;
  lastSyncRevision?: number;
  lastSyncErrorCode?: string;
};

export type ConnectedCoreList = { version: 1; cores: ConnectedCore[] };

export type SettingsHistoryEntry = {
  version: 1;
  settingsRevision: number;
  syncRevision: number;
  createdAt: string;
  settings: SharedSettings;
};

export type SettingsHistory = { version: 1; entries: SettingsHistoryEntry[] };

export type RollbackSettingsRequest = {
  version: 1;
  baseSettingsRevision: number;
  targetSettingsRevision: number;
};

export type BackupMetadata = {
  version: 1;
  serverId: string;
  createdAt: string;
  settingsRevision: number;
  syncRevision: number;
  connectedCoreCount: number;
  credentialCount: number;
};

export type EnrollmentDecisionRequest = {
  version: 1;
  decision: "approve" | "reject";
};

export type PendingEnrollment = {
  version: 1;
  id: string;
  name: string;
  platform: "windows" | "macos" | "linux" | "other";
  appVersion: string;
  credentialSource: "local" | "sync";
  createdAt: string;
  expiresAt: string;
};

export type PendingEnrollmentList = { version: 1; enrollments: PendingEnrollment[] };

export type ModelCandidate = {
  model: ModelRef;
  supportedCoreIds: string[];
  unsupportedCoreIds: string[];
};

export type ModelCatalog = { version: 1; models: ModelCandidate[] };

export type AdministratorStatus = {
  version: 1;
  state: "setup-required" | "ready" | "authenticated";
  csrfToken?: string;
};

export type ServerOverview = {
  version: 1;
  serverId: string;
  settingsRevision: number;
  syncRevision: number;
  connectedCoreCount: number;
  pendingEnrollmentCount: number;
  recentSyncErrors: Array<{ coreId: string; coreName: string; code: string }>;
};

export type AdministratorSetupRequest = {
  version: 1;
  setupCode: string;
  password: string;
};

export type AdministratorLoginRequest = {
  version: 1;
  password: string;
};

export type AdministratorAuthenticated = {
  version: 1;
  state: "authenticated";
  csrfToken: string;
  expiresAt: string;
};

export function parseSharedSettings(value: unknown, path = "settings"): SharedSettings {
  const object = strictObject(value, ["version", "defaultModel", "webTools"], path);
  versionOne(object, path);
  const webTools = strictObject(object.webTools, ["searchPrimary"], `${path}.webTools`);
  const defaultModel =
    object.defaultModel === undefined
      ? undefined
      : modelRefAt(object.defaultModel, `${path}.defaultModel`);
  return {
    version: 1,
    ...(defaultModel ? { defaultModel } : {}),
    webTools: {
      searchPrimary: oneOf(
        webTools.searchPrimary,
        ["auto", "exa", "brave"] as const,
        `${path}.webTools.searchPrimary`,
      ),
    },
  };
}

export function parseSharedSettingsView(value: unknown): SharedSettingsView {
  const object = strictObject(
    value,
    ["version", "settingsRevision", "syncRevision", "settings"],
    "response",
  );
  versionOne(object, "response");
  return {
    version: 1,
    settingsRevision: integerAt(object.settingsRevision, "response.settingsRevision"),
    syncRevision: integerAt(object.syncRevision, "response.syncRevision"),
    settings: parseSharedSettings(object.settings, "response.settings"),
  };
}

export function parseUpdateSharedSettingsRequest(value: unknown): UpdateSharedSettingsRequest {
  const object = strictObject(value, ["version", "baseSettingsRevision", "settings"], "request");
  versionOne(object, "request");
  return {
    version: 1,
    baseSettingsRevision: integerAt(object.baseSettingsRevision, "request.baseSettingsRevision"),
    settings: parseSharedSettings(object.settings, "request.settings"),
  };
}

function parseCredentialStatusAt(value: unknown, path: string): CredentialStatus {
  const object = strictObject(value, ["version", "provider", "configured"], path);
  versionOne(object, path);
  return {
    version: 1,
    provider: stringAt(object.provider, `${path}.provider`, 128),
    configured: booleanAt(object.configured, `${path}.configured`),
  };
}

export function parseCredentialStatus(value: unknown): CredentialStatus {
  return parseCredentialStatusAt(value, "response");
}

export function parseCredentialStatusList(value: unknown): CredentialStatusList {
  const object = strictObject(value, ["version", "credentials", "syncRevision"], "response");
  versionOne(object, "response");
  return {
    version: 1,
    credentials: arrayAt(object.credentials, "response.credentials", parseCredentialStatusAt, 256),
    syncRevision: integerAt(object.syncRevision, "response.syncRevision"),
  };
}

export function parsePutCredentialRequest(value: unknown): PutCredentialRequest {
  const object = strictObject(value, ["version", "apiKey"], "request");
  versionOne(object, "request");
  return { version: 1, apiKey: stringAt(object.apiKey, "request.apiKey", 16_384) };
}

function parseConnectedCoreAt(value: unknown, path: string): ConnectedCore {
  const object = strictObject(
    value,
    [
      "version",
      "id",
      "name",
      "platform",
      "appVersion",
      "credentialSource",
      "revoked",
      "lastSeenAt",
      "lastSyncRevision",
      "lastSyncErrorCode",
    ],
    path,
  );
  versionOne(object, path);
  const lastSyncRevision =
    object.lastSyncRevision === undefined
      ? undefined
      : integerAt(object.lastSyncRevision, `${path}.lastSyncRevision`);
  const lastSeenAt = optionalStringAt(object.lastSeenAt, `${path}.lastSeenAt`, 64);
  const lastSyncErrorCode = optionalStringAt(
    object.lastSyncErrorCode,
    `${path}.lastSyncErrorCode`,
    128,
  );
  return {
    version: 1,
    id: stringAt(object.id, `${path}.id`, 128),
    name: stringAt(object.name, `${path}.name`, 128),
    platform: oneOf(
      object.platform,
      ["windows", "macos", "linux", "other"] as const,
      `${path}.platform`,
    ),
    appVersion: stringAt(object.appVersion, `${path}.appVersion`, 64),
    credentialSource: oneOf(
      object.credentialSource,
      ["local", "sync"] as const,
      `${path}.credentialSource`,
    ),
    revoked: booleanAt(object.revoked, `${path}.revoked`),
    ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
    ...(lastSyncRevision === undefined ? {} : { lastSyncRevision }),
    ...(lastSyncErrorCode === undefined ? {} : { lastSyncErrorCode }),
  };
}

export function parseConnectedCoreList(value: unknown): ConnectedCoreList {
  const object = strictObject(value, ["version", "cores"], "response");
  versionOne(object, "response");
  return {
    version: 1,
    cores: arrayAt(object.cores, "response.cores", parseConnectedCoreAt, 1_000),
  };
}

function parseHistoryEntryAt(value: unknown, path: string): SettingsHistoryEntry {
  const object = strictObject(
    value,
    ["version", "settingsRevision", "syncRevision", "createdAt", "settings"],
    path,
  );
  versionOne(object, path);
  return {
    version: 1,
    settingsRevision: integerAt(object.settingsRevision, `${path}.settingsRevision`),
    syncRevision: integerAt(object.syncRevision, `${path}.syncRevision`),
    createdAt: stringAt(object.createdAt, `${path}.createdAt`, 64),
    settings: parseSharedSettings(object.settings, `${path}.settings`),
  };
}

export function parseSettingsHistory(value: unknown): SettingsHistory {
  const object = strictObject(value, ["version", "entries"], "response");
  versionOne(object, "response");
  return {
    version: 1,
    entries: arrayAt(object.entries, "response.entries", parseHistoryEntryAt, 1_000),
  };
}

export function parseRollbackSettingsRequest(value: unknown): RollbackSettingsRequest {
  const object = strictObject(
    value,
    ["version", "baseSettingsRevision", "targetSettingsRevision"],
    "request",
  );
  versionOne(object, "request");
  return {
    version: 1,
    baseSettingsRevision: integerAt(object.baseSettingsRevision, "request.baseSettingsRevision"),
    targetSettingsRevision: integerAt(
      object.targetSettingsRevision,
      "request.targetSettingsRevision",
    ),
  };
}

export function parseBackupMetadata(value: unknown): BackupMetadata {
  const object = strictObject(
    value,
    [
      "version",
      "serverId",
      "createdAt",
      "settingsRevision",
      "syncRevision",
      "connectedCoreCount",
      "credentialCount",
    ],
    "response",
  );
  versionOne(object, "response");
  return {
    version: 1,
    serverId: stringAt(object.serverId, "response.serverId", 128),
    createdAt: stringAt(object.createdAt, "response.createdAt", 64),
    settingsRevision: integerAt(object.settingsRevision, "response.settingsRevision"),
    syncRevision: integerAt(object.syncRevision, "response.syncRevision"),
    connectedCoreCount: integerAt(object.connectedCoreCount, "response.connectedCoreCount"),
    credentialCount: integerAt(object.credentialCount, "response.credentialCount"),
  };
}

export function parseEnrollmentDecisionRequest(value: unknown): EnrollmentDecisionRequest {
  const object = strictObject(value, ["version", "decision"], "request");
  versionOne(object, "request");
  return {
    version: 1,
    decision: oneOf(object.decision, ["approve", "reject"] as const, "request.decision"),
  };
}

function parsePendingEnrollmentAt(value: unknown, path: string): PendingEnrollment {
  const object = strictObject(
    value,
    [
      "version",
      "id",
      "name",
      "platform",
      "appVersion",
      "credentialSource",
      "createdAt",
      "expiresAt",
    ],
    path,
  );
  versionOne(object, path);
  return {
    version: 1,
    id: stringAt(object.id, `${path}.id`, 128),
    name: stringAt(object.name, `${path}.name`, 128),
    platform: oneOf(
      object.platform,
      ["windows", "macos", "linux", "other"] as const,
      `${path}.platform`,
    ),
    appVersion: stringAt(object.appVersion, `${path}.appVersion`, 64),
    credentialSource: oneOf(
      object.credentialSource,
      ["local", "sync"] as const,
      `${path}.credentialSource`,
    ),
    createdAt: stringAt(object.createdAt, `${path}.createdAt`, 64),
    expiresAt: stringAt(object.expiresAt, `${path}.expiresAt`, 64),
  };
}

export function parsePendingEnrollmentList(value: unknown): PendingEnrollmentList {
  const object = strictObject(value, ["version", "enrollments"], "response");
  versionOne(object, "response");
  return {
    version: 1,
    enrollments: arrayAt(
      object.enrollments,
      "response.enrollments",
      parsePendingEnrollmentAt,
      1_000,
    ),
  };
}

function parseStringArray(value: unknown, path: string): string[] {
  return arrayAt(value, path, (entry, entryPath) => stringAt(entry, entryPath, 128), 10_000);
}

function parseModelCandidateAt(value: unknown, path: string): ModelCandidate {
  const object = strictObject(value, ["model", "supportedCoreIds", "unsupportedCoreIds"], path);
  return {
    model: modelRefAt(object.model, `${path}.model`),
    supportedCoreIds: parseStringArray(object.supportedCoreIds, `${path}.supportedCoreIds`),
    unsupportedCoreIds: parseStringArray(object.unsupportedCoreIds, `${path}.unsupportedCoreIds`),
  };
}

export function parseModelCatalog(value: unknown): ModelCatalog {
  const object = strictObject(value, ["version", "models"], "response");
  versionOne(object, "response");
  return {
    version: 1,
    models: arrayAt(object.models, "response.models", parseModelCandidateAt, 10_000),
  };
}

export function parseAdministratorStatus(value: unknown): AdministratorStatus {
  const object = strictObject(value, ["version", "state", "csrfToken"], "response");
  versionOne(object, "response");
  const state = oneOf(
    object.state,
    ["setup-required", "ready", "authenticated"] as const,
    "response.state",
  );
  const csrfToken = optionalStringAt(object.csrfToken, "response.csrfToken", 512);
  if ((state === "authenticated") !== (csrfToken !== undefined)) {
    throw new Error("response.csrfToken: required only for authenticated state");
  }
  return {
    version: 1,
    state,
    ...(csrfToken ? { csrfToken } : {}),
  };
}

export function parseServerOverview(value: unknown): ServerOverview {
  const object = strictObject(
    value,
    [
      "version",
      "serverId",
      "settingsRevision",
      "syncRevision",
      "connectedCoreCount",
      "pendingEnrollmentCount",
      "recentSyncErrors",
    ],
    "response",
  );
  versionOne(object, "response");
  return {
    version: 1,
    serverId: stringAt(object.serverId, "response.serverId", 128),
    settingsRevision: integerAt(object.settingsRevision, "response.settingsRevision"),
    syncRevision: integerAt(object.syncRevision, "response.syncRevision"),
    connectedCoreCount: integerAt(object.connectedCoreCount, "response.connectedCoreCount"),
    pendingEnrollmentCount: integerAt(
      object.pendingEnrollmentCount,
      "response.pendingEnrollmentCount",
    ),
    recentSyncErrors: arrayAt(
      object.recentSyncErrors,
      "response.recentSyncErrors",
      (entry, path) => {
        const error = strictObject(entry, ["coreId", "coreName", "code"], path);
        return {
          coreId: stringAt(error.coreId, `${path}.coreId`, 128),
          coreName: stringAt(error.coreName, `${path}.coreName`, 128),
          code: stringAt(error.code, `${path}.code`, 128),
        };
      },
      1_000,
    ),
  };
}

export function parseAdministratorSetupRequest(value: unknown): AdministratorSetupRequest {
  const object = strictObject(value, ["version", "setupCode", "password"], "request");
  versionOne(object, "request");
  return {
    version: 1,
    setupCode: stringAt(object.setupCode, "request.setupCode", 512),
    password: stringAt(object.password, "request.password", 4_096),
  };
}

export function parseAdministratorLoginRequest(value: unknown): AdministratorLoginRequest {
  const object = strictObject(value, ["version", "password"], "request");
  versionOne(object, "request");
  return { version: 1, password: stringAt(object.password, "request.password", 4_096) };
}

export function parseAdministratorAuthenticated(value: unknown): AdministratorAuthenticated {
  const object = strictObject(value, ["version", "state", "csrfToken", "expiresAt"], "response");
  versionOne(object, "response");
  if (object.state !== "authenticated") {
    throw new Error("response.state: expected authenticated");
  }
  return {
    version: 1,
    state: "authenticated",
    csrfToken: stringAt(object.csrfToken, "response.csrfToken", 512),
    expiresAt: stringAt(object.expiresAt, "response.expiresAt", 64),
  };
}
