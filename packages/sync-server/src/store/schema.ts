import {
  type CoreCapabilities,
  type CorePlatform,
  type CredentialSource,
  type SharedSettings,
  parseCoreCapabilities,
  parseSharedSettings,
} from "@cinba/sync-contract";
import type { CredentialEnvelope, SecretHash } from "../security/credentials.ts";

export type StoredSettingsHistoryEntry = {
  settingsRevision: number;
  syncRevision: number;
  createdAt: string;
  settings: SharedSettings;
};

export type StoredCore = {
  id: string;
  name: string;
  platform: CorePlatform;
  appVersion: string;
  credentialSource: CredentialSource;
  createdAt: string;
  revokedAt?: string;
  tokenHash: SecretHash;
  capabilities?: CoreCapabilities;
  lastSeenAt?: string;
  lastSyncRevision?: number;
  lastSyncErrorCode?: string;
};

export type StoredEnrollment = {
  id: string;
  name: string;
  platform: CorePlatform;
  appVersion: string;
  credentialSource: CredentialSource;
  createdAt: string;
  expiresAt: string;
  secretHash: SecretHash;
  status: "pending" | "approved" | "rejected";
  coreId?: string;
  credentialDelivery?: CredentialEnvelope;
};

export type SyncState = {
  version: 1;
  serverId: string;
  settings: SharedSettings;
  settingsRevision: number;
  syncRevision: number;
  history: StoredSettingsHistoryEntry[];
  credentials: Record<string, CredentialEnvelope>;
  cores: StoredCore[];
  enrollments: StoredEnrollment[];
  administrator?: SecretHash;
  setupCode?: SecretHash;
  setupCodeDisplay?: CredentialEnvelope;
};

export class SyncStateSchemaError extends Error {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "SyncStateSchemaError";
  }
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SyncStateSchemaError(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function strictObject(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  const object = objectAt(value, path);
  const allowed = new Set(keys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new SyncStateSchemaError(`${path}.${key}`, "unexpected field");
    }
  }
  return object;
}

function stringAt(value: unknown, path: string, maximum = 512): string {
  if (typeof value !== "string" || value === "" || value.length > maximum) {
    throw new SyncStateSchemaError(path, "expected a bounded non-empty string");
  }
  return value;
}

function integerAt(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SyncStateSchemaError(path, "expected a non-negative safe integer");
  }
  return value as number;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new SyncStateSchemaError(path, `expected one of ${choices.join(", ")}`);
  }
  return value as T[number];
}

function arrayAt<T>(
  value: unknown,
  path: string,
  parse: (item: unknown, path: string) => T,
  maximum = 10_000,
): T[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new SyncStateSchemaError(path, "expected a bounded array");
  }
  return value.map((item, index) => parse(item, `${path}[${index}]`));
}

function base64At(value: unknown, path: string, expectedBytes?: number): string {
  const text = stringAt(value, path, 100_000);
  const decoded = Buffer.from(text, "base64");
  if (decoded.toString("base64") !== text || decoded.byteLength === 0) {
    throw new SyncStateSchemaError(path, "expected canonical base64");
  }
  if (expectedBytes !== undefined && decoded.byteLength !== expectedBytes) {
    throw new SyncStateSchemaError(path, `expected ${expectedBytes} bytes`);
  }
  return text;
}

export function parseCredentialEnvelope(value: unknown, path: string): CredentialEnvelope {
  const object = strictObject(value, ["version", "algorithm", "nonce", "tag", "ciphertext"], path);
  if (object.version !== 1 || object.algorithm !== "aes-256-gcm") {
    throw new SyncStateSchemaError(path, "unsupported credential envelope");
  }
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    nonce: base64At(object.nonce, `${path}.nonce`, 12),
    tag: base64At(object.tag, `${path}.tag`, 16),
    ciphertext: base64At(object.ciphertext, `${path}.ciphertext`),
  };
}

export function parseSecretHash(value: unknown, path: string): SecretHash {
  const object = strictObject(
    value,
    ["version", "algorithm", "salt", "digest", "cost", "blockSize", "parallelization"],
    path,
  );
  if (
    object.version !== 1 ||
    object.algorithm !== "scrypt" ||
    object.cost !== 16_384 ||
    object.blockSize !== 8 ||
    object.parallelization !== 1
  ) {
    throw new SyncStateSchemaError(path, "unsupported secret hash parameters");
  }
  return {
    version: 1,
    algorithm: "scrypt",
    salt: base64At(object.salt, `${path}.salt`, 16),
    digest: base64At(object.digest, `${path}.digest`, 32),
    cost: 16_384,
    blockSize: 8,
    parallelization: 1,
  };
}

function parseHistoryEntry(value: unknown, path: string): StoredSettingsHistoryEntry {
  const object = strictObject(
    value,
    ["settingsRevision", "syncRevision", "createdAt", "settings"],
    path,
  );
  return {
    settingsRevision: integerAt(object.settingsRevision, `${path}.settingsRevision`),
    syncRevision: integerAt(object.syncRevision, `${path}.syncRevision`),
    createdAt: stringAt(object.createdAt, `${path}.createdAt`, 64),
    settings: parseSharedSettings(object.settings, `${path}.settings`),
  };
}

function parseCore(value: unknown, path: string): StoredCore {
  const object = strictObject(
    value,
    [
      "id",
      "name",
      "platform",
      "appVersion",
      "credentialSource",
      "createdAt",
      "revokedAt",
      "tokenHash",
      "capabilities",
      "lastSeenAt",
      "lastSyncRevision",
      "lastSyncErrorCode",
    ],
    path,
  );
  const revokedAt =
    object.revokedAt === undefined
      ? undefined
      : stringAt(object.revokedAt, `${path}.revokedAt`, 64);
  const capabilities =
    object.capabilities === undefined
      ? undefined
      : parseCoreCapabilities(object.capabilities, `${path}.capabilities`);
  const lastSeenAt =
    object.lastSeenAt === undefined
      ? undefined
      : stringAt(object.lastSeenAt, `${path}.lastSeenAt`, 64);
  const lastSyncRevision =
    object.lastSyncRevision === undefined
      ? undefined
      : integerAt(object.lastSyncRevision, `${path}.lastSyncRevision`);
  const lastSyncErrorCode =
    object.lastSyncErrorCode === undefined
      ? undefined
      : stringAt(object.lastSyncErrorCode, `${path}.lastSyncErrorCode`, 128);
  return {
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
    tokenHash: parseSecretHash(object.tokenHash, `${path}.tokenHash`),
    ...(revokedAt ? { revokedAt } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
    ...(lastSyncRevision === undefined ? {} : { lastSyncRevision }),
    ...(lastSyncErrorCode ? { lastSyncErrorCode } : {}),
  };
}

function parseEnrollment(value: unknown, path: string): StoredEnrollment {
  const object = strictObject(
    value,
    [
      "id",
      "name",
      "platform",
      "appVersion",
      "credentialSource",
      "createdAt",
      "expiresAt",
      "secretHash",
      "status",
      "coreId",
      "credentialDelivery",
    ],
    path,
  );
  const status = oneOf(
    object.status,
    ["pending", "approved", "rejected"] as const,
    `${path}.status`,
  );
  const coreId =
    object.coreId === undefined ? undefined : stringAt(object.coreId, `${path}.coreId`, 128);
  const credentialDelivery =
    object.credentialDelivery === undefined
      ? undefined
      : parseCredentialEnvelope(object.credentialDelivery, `${path}.credentialDelivery`);
  if (
    (status === "approved" && (!coreId || !credentialDelivery)) ||
    (status !== "approved" && (coreId || credentialDelivery))
  ) {
    throw new SyncStateSchemaError(path, "enrollment status fields are inconsistent");
  }
  return {
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
    secretHash: parseSecretHash(object.secretHash, `${path}.secretHash`),
    status,
    ...(coreId ? { coreId } : {}),
    ...(credentialDelivery ? { credentialDelivery } : {}),
  };
}

export function parseSyncState(value: unknown): SyncState {
  const object = strictObject(
    value,
    [
      "version",
      "serverId",
      "settings",
      "settingsRevision",
      "syncRevision",
      "history",
      "credentials",
      "cores",
      "enrollments",
      "administrator",
      "setupCode",
      "setupCodeDisplay",
    ],
    "state",
  );
  if (object.version !== 1) {
    throw new SyncStateSchemaError("state.version", "unsupported schema version");
  }
  const credentialsObject = objectAt(object.credentials, "state.credentials");
  if (Object.keys(credentialsObject).length > 256) {
    throw new SyncStateSchemaError("state.credentials", "too many providers");
  }
  const credentials = Object.fromEntries(
    Object.entries(credentialsObject).map(([provider, envelope]) => [
      stringAt(provider, "state.credentials.provider", 128),
      parseCredentialEnvelope(envelope, `state.credentials.${provider}`),
    ]),
  );
  const history = arrayAt(object.history, "state.history", parseHistoryEntry);
  const settings = parseSharedSettings(object.settings, "state.settings");
  const settingsRevision = integerAt(object.settingsRevision, "state.settingsRevision");
  const syncRevision = integerAt(object.syncRevision, "state.syncRevision");
  const latest = history.at(-1);
  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index]!;
    const previous = history[index - 1];
    if (
      (index === 0 && (entry.settingsRevision !== 0 || entry.syncRevision !== 0)) ||
      (previous !== undefined &&
        (entry.settingsRevision !== previous.settingsRevision + 1 ||
          entry.syncRevision <= previous.syncRevision)) ||
      entry.syncRevision > syncRevision
    ) {
      throw new SyncStateSchemaError("state.history", "revisions are not monotonic");
    }
  }
  if (
    !latest ||
    settingsRevision > syncRevision ||
    latest.settingsRevision !== settingsRevision ||
    latest.syncRevision > syncRevision ||
    JSON.stringify(latest.settings) !== JSON.stringify(settings)
  ) {
    throw new SyncStateSchemaError("state.history", "latest entry does not match current state");
  }
  const hasAdministrator = object.administrator !== undefined;
  const hasSetupCode = object.setupCode !== undefined;
  const hasSetupCodeDisplay = object.setupCodeDisplay !== undefined;
  if (hasAdministrator === hasSetupCode || hasSetupCode !== hasSetupCodeDisplay) {
    throw new SyncStateSchemaError(
      "state",
      "expected either an administrator or one complete pending Setup Code",
    );
  }
  return {
    version: 1,
    serverId: stringAt(object.serverId, "state.serverId", 128),
    settings,
    settingsRevision,
    syncRevision,
    history,
    credentials,
    cores: arrayAt(object.cores, "state.cores", parseCore, 10_000),
    enrollments: arrayAt(object.enrollments, "state.enrollments", parseEnrollment, 10_000),
    ...(object.administrator === undefined
      ? {}
      : { administrator: parseSecretHash(object.administrator, "state.administrator") }),
    ...(object.setupCode === undefined
      ? {}
      : { setupCode: parseSecretHash(object.setupCode, "state.setupCode") }),
    ...(object.setupCodeDisplay === undefined
      ? {}
      : {
          setupCodeDisplay: parseCredentialEnvelope(
            object.setupCodeDisplay,
            "state.setupCodeDisplay",
          ),
        }),
  };
}
