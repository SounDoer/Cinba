import {
  type ModelRef,
  arrayAt,
  integerAt,
  modelRefAt,
  objectAt,
  oneOf,
  strictObject,
  stringAt,
  versionOne,
} from "./schemas.ts";
import { type SharedSettings, parseSharedSettings } from "./management.ts";

export type CredentialSource = "local" | "sync";
export type CorePlatform = "windows" | "macos" | "linux" | "other";

export type ProviderCapability = {
  id: string;
  name: string;
  authKind: "api-key" | "oauth" | "other";
};

export type CoreCapabilities = {
  version: 1;
  providers: ProviderCapability[];
  models: ModelRef[];
};

export type EnrollmentRequest = {
  version: 1;
  name: string;
  platform: CorePlatform;
  appVersion: string;
  credentialSource: CredentialSource;
};

export type EnrollmentCreated = {
  version: 1;
  enrollmentId: string;
  enrollmentSecret: string;
  expiresAt: string;
};

export type EnrollmentStatus =
  | { version: 1; status: "pending" }
  | { version: 1; status: "approved"; coreId: string; coreCredential: string }
  | { version: 1; status: "rejected" | "expired" };

export type SyncSnapshot = {
  version: 1;
  syncRevision: number;
  settingsRevision: number;
  settings: SharedSettings;
  credentials?: Record<string, string>;
};

export type CapabilitiesReport = {
  version: 1;
  capabilities: CoreCapabilities;
  currentSyncRevision?: number;
  lastSyncErrorCode?: string;
};

export type CoreReportAccepted = { version: 1; accepted: true };

function parseProviderAt(value: unknown, path: string): ProviderCapability {
  const object = strictObject(value, ["id", "name", "authKind"], path);
  return {
    id: stringAt(object.id, `${path}.id`, 128),
    name: stringAt(object.name, `${path}.name`, 128),
    authKind: oneOf(object.authKind, ["api-key", "oauth", "other"] as const, `${path}.authKind`),
  };
}

export function parseCoreCapabilities(value: unknown, path = "capabilities"): CoreCapabilities {
  const object = strictObject(value, ["version", "providers", "models"], path);
  versionOne(object, path);
  return {
    version: 1,
    providers: arrayAt(object.providers, `${path}.providers`, parseProviderAt, 256),
    models: arrayAt(object.models, `${path}.models`, modelRefAt, 10_000),
  };
}

export function parseEnrollmentRequest(value: unknown): EnrollmentRequest {
  const object = strictObject(
    value,
    ["version", "name", "platform", "appVersion", "credentialSource"],
    "request",
  );
  versionOne(object, "request");
  return {
    version: 1,
    name: stringAt(object.name, "request.name", 128),
    platform: oneOf(
      object.platform,
      ["windows", "macos", "linux", "other"] as const,
      "request.platform",
    ),
    appVersion: stringAt(object.appVersion, "request.appVersion", 64),
    credentialSource: oneOf(
      object.credentialSource,
      ["local", "sync"] as const,
      "request.credentialSource",
    ),
  };
}

export function parseEnrollmentCreated(value: unknown): EnrollmentCreated {
  const object = strictObject(
    value,
    ["version", "enrollmentId", "enrollmentSecret", "expiresAt"],
    "response",
  );
  versionOne(object, "response");
  return {
    version: 1,
    enrollmentId: stringAt(object.enrollmentId, "response.enrollmentId", 128),
    enrollmentSecret: stringAt(object.enrollmentSecret, "response.enrollmentSecret", 512),
    expiresAt: stringAt(object.expiresAt, "response.expiresAt", 64),
  };
}

export function parseEnrollmentStatus(value: unknown): EnrollmentStatus {
  const base = objectAt(value, "response");
  const status = oneOf(
    base.status,
    ["pending", "approved", "rejected", "expired"] as const,
    "response.status",
  );
  if (status === "approved") {
    const object = strictObject(
      value,
      ["version", "status", "coreId", "coreCredential"],
      "response",
    );
    versionOne(object, "response");
    return {
      version: 1,
      status,
      coreId: stringAt(object.coreId, "response.coreId", 128),
      coreCredential: stringAt(object.coreCredential, "response.coreCredential", 512),
    };
  }
  const object = strictObject(value, ["version", "status"], "response");
  versionOne(object, "response");
  return { version: 1, status };
}

function parseCredentials(value: unknown, path: string): Record<string, string> {
  const object = objectAt(value, path);
  const entries = Object.entries(object);
  if (entries.length > 256) {
    throw new Error(`${path}: too many credential entries`);
  }
  return Object.fromEntries(
    entries.map(([provider, credential]) => [
      stringAt(provider, `${path}.provider`, 128),
      stringAt(credential, `${path}.${provider}`, 16_384),
    ]),
  );
}

export function parseSyncSnapshot(value: unknown): SyncSnapshot {
  const object = strictObject(
    value,
    ["version", "syncRevision", "settingsRevision", "settings", "credentials"],
    "response",
  );
  versionOne(object, "response");
  const credentials =
    object.credentials === undefined
      ? undefined
      : parseCredentials(object.credentials, "response.credentials");
  return {
    version: 1,
    syncRevision: integerAt(object.syncRevision, "response.syncRevision"),
    settingsRevision: integerAt(object.settingsRevision, "response.settingsRevision"),
    settings: parseSharedSettings(object.settings, "response.settings"),
    ...(credentials ? { credentials } : {}),
  };
}

export function parseCapabilitiesReport(value: unknown): CapabilitiesReport {
  const object = strictObject(
    value,
    ["version", "capabilities", "currentSyncRevision", "lastSyncErrorCode"],
    "request",
  );
  versionOne(object, "request");
  const currentSyncRevision =
    object.currentSyncRevision === undefined
      ? undefined
      : integerAt(object.currentSyncRevision, "request.currentSyncRevision");
  const lastSyncErrorCode =
    object.lastSyncErrorCode === undefined
      ? undefined
      : stringAt(object.lastSyncErrorCode, "request.lastSyncErrorCode", 128);
  return {
    version: 1,
    capabilities: parseCoreCapabilities(object.capabilities, "request.capabilities"),
    ...(currentSyncRevision === undefined ? {} : { currentSyncRevision }),
    ...(lastSyncErrorCode === undefined ? {} : { lastSyncErrorCode }),
  };
}

export function parseCoreReportAccepted(value: unknown): CoreReportAccepted {
  const object = strictObject(value, ["version", "accepted"], "response");
  versionOne(object, "response");
  if (object.accepted !== true) {
    throw new Error("response.accepted: expected true");
  }
  return { version: 1, accepted: true };
}
