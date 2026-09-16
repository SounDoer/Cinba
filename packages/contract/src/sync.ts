import type { ModelRef, WebSearchPrimary } from "./protocol.ts";

export type CoreSyncState = "disconnected" | "pending" | "online" | "stale" | "error" | "revoked";
export type SyncSettingsSource = "local" | "sync";
export type SyncCredentialSource = "local" | "sync";

export type CoreSyncSources = {
  settings: SyncSettingsSource;
  credentials: SyncCredentialSource;
};

export type CoreInstanceOverride = {
  defaultModel?: ModelRef;
  webTools?: { searchPrimary?: WebSearchPrimary };
};

export type CoreSyncSettings = {
  defaultModel?: ModelRef;
  webTools: { searchPrimary: WebSearchPrimary };
};

export type CoreSyncView = {
  version: 1;
  state: CoreSyncState;
  sources: CoreSyncSources;
  effectiveSettingsSource: "local" | "sync" | "local-fallback";
  serverUrl?: string;
  managementUrl?: string;
  enrollmentExpiresAt?: string;
  lastSuccessAt?: string;
  syncRevision?: number;
  settingsRevision?: number;
  errorCode?: "offline" | "invalid_snapshot" | "cache_write_failed" | "revoked";
  action?: "retry" | "reconnect";
  shared?: CoreSyncSettings;
  override: CoreInstanceOverride;
  effective: CoreSyncSettings;
};

export type ConnectCoreSyncRequest = {
  version: 1;
  serverUrl: string;
  sources: CoreSyncSources;
};

export type UpdateCoreSyncSourcesRequest = { version: 1; sources: CoreSyncSources };
export type UpdateCoreInstanceOverrideRequest = {
  version: 1;
  override: CoreInstanceOverride;
};
export type CoreSyncOperationAccepted = { version: 1; accepted: true };

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  const result = object(value, name);
  const allowed = new Set(keys);
  if (Object.keys(result).some((key) => !allowed.has(key))) {
    throw new Error(`${name} has an unexpected field`);
  }
  return result;
}

function version(value: Record<string, unknown>, name: string): void {
  if (value.version !== 1) {
    throw new Error(`${name}.version must be 1`);
  }
}

function nonEmpty(value: unknown, name: string, maximum = 512): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : nonEmpty(value, name);
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value as number;
}

function model(value: unknown, name: string): ModelRef {
  const result = exact(value, ["provider", "id"], name);
  return {
    provider: nonEmpty(result.provider, `${name}.provider`, 128),
    id: nonEmpty(result.id, `${name}.id`, 256),
  };
}

function primary(value: unknown, name: string): WebSearchPrimary {
  if (value !== "auto" && value !== "exa" && value !== "brave") {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

export function parseCoreSyncSources(value: unknown, name = "sources"): CoreSyncSources {
  const result = exact(value, ["settings", "credentials"], name);
  if (result.settings !== "local" && result.settings !== "sync") {
    throw new Error(`${name}.settings is invalid`);
  }
  if (result.credentials !== "local" && result.credentials !== "sync") {
    throw new Error(`${name}.credentials is invalid`);
  }
  if (result.settings === "local" && result.credentials === "sync") {
    throw new Error("Local Settings cannot use Shared Credentials");
  }
  return { settings: result.settings, credentials: result.credentials };
}

function parseOverride(value: unknown, name: string): CoreInstanceOverride {
  const result = exact(value, ["defaultModel", "webTools"], name);
  const webTools =
    result.webTools === undefined
      ? undefined
      : exact(result.webTools, ["searchPrimary"], `${name}.webTools`);
  return {
    ...(result.defaultModel === undefined
      ? {}
      : { defaultModel: model(result.defaultModel, `${name}.defaultModel`) }),
    ...(webTools?.searchPrimary === undefined
      ? {}
      : {
          webTools: {
            searchPrimary: primary(webTools.searchPrimary, `${name}.webTools.searchPrimary`),
          },
        }),
  };
}

function parseSettings(value: unknown, name: string): CoreSyncSettings {
  const result = exact(value, ["defaultModel", "webTools"], name);
  const webTools = exact(result.webTools, ["searchPrimary"], `${name}.webTools`);
  return {
    ...(result.defaultModel === undefined
      ? {}
      : { defaultModel: model(result.defaultModel, `${name}.defaultModel`) }),
    webTools: { searchPrimary: primary(webTools.searchPrimary, `${name}.webTools.searchPrimary`) },
  };
}

export function parseConnectCoreSyncRequest(value: unknown): ConnectCoreSyncRequest {
  const result = exact(value, ["version", "serverUrl", "sources"], "request");
  version(result, "request");
  return {
    version: 1,
    serverUrl: nonEmpty(result.serverUrl, "request.serverUrl", 2048),
    sources: parseCoreSyncSources(result.sources, "request.sources"),
  };
}

export function parseUpdateCoreSyncSourcesRequest(value: unknown): UpdateCoreSyncSourcesRequest {
  const result = exact(value, ["version", "sources"], "request");
  version(result, "request");
  return { version: 1, sources: parseCoreSyncSources(result.sources, "request.sources") };
}

export function parseUpdateCoreInstanceOverrideRequest(
  value: unknown,
): UpdateCoreInstanceOverrideRequest {
  const result = exact(value, ["version", "override"], "request");
  version(result, "request");
  return { version: 1, override: parseOverride(result.override, "request.override") };
}

export function parseCoreSyncOperationAccepted(value: unknown): CoreSyncOperationAccepted {
  const result = exact(value, ["version", "accepted"], "response");
  version(result, "response");
  if (result.accepted !== true) {
    throw new Error("response.accepted must be true");
  }
  return { version: 1, accepted: true };
}

export function parseCoreSyncView(value: unknown): CoreSyncView {
  const result = exact(
    value,
    [
      "version",
      "state",
      "sources",
      "effectiveSettingsSource",
      "serverUrl",
      "managementUrl",
      "enrollmentExpiresAt",
      "lastSuccessAt",
      "syncRevision",
      "settingsRevision",
      "errorCode",
      "action",
      "shared",
      "override",
      "effective",
    ],
    "response",
  );
  version(result, "response");
  const states = ["disconnected", "pending", "online", "stale", "error", "revoked"];
  if (typeof result.state !== "string" || !states.includes(result.state)) {
    throw new Error("response.state is invalid");
  }
  const effectiveSources = ["local", "sync", "local-fallback"];
  if (
    typeof result.effectiveSettingsSource !== "string" ||
    !effectiveSources.includes(result.effectiveSettingsSource)
  ) {
    throw new Error("response.effectiveSettingsSource is invalid");
  }
  const errorCodes = ["offline", "invalid_snapshot", "cache_write_failed", "revoked"];
  if (
    result.errorCode !== undefined &&
    (typeof result.errorCode !== "string" || !errorCodes.includes(result.errorCode))
  ) {
    throw new Error("response.errorCode is invalid");
  }
  if (result.action !== undefined && result.action !== "retry" && result.action !== "reconnect") {
    throw new Error("response.action is invalid");
  }
  return {
    version: 1,
    state: result.state as CoreSyncState,
    sources: parseCoreSyncSources(result.sources, "response.sources"),
    effectiveSettingsSource:
      result.effectiveSettingsSource as CoreSyncView["effectiveSettingsSource"],
    ...(optionalString(result.serverUrl, "response.serverUrl")
      ? { serverUrl: result.serverUrl as string }
      : {}),
    ...(optionalString(result.managementUrl, "response.managementUrl")
      ? { managementUrl: result.managementUrl as string }
      : {}),
    ...(optionalString(result.enrollmentExpiresAt, "response.enrollmentExpiresAt")
      ? { enrollmentExpiresAt: result.enrollmentExpiresAt as string }
      : {}),
    ...(optionalString(result.lastSuccessAt, "response.lastSuccessAt")
      ? { lastSuccessAt: result.lastSuccessAt as string }
      : {}),
    ...(optionalInteger(result.syncRevision, "response.syncRevision") === undefined
      ? {}
      : { syncRevision: result.syncRevision as number }),
    ...(optionalInteger(result.settingsRevision, "response.settingsRevision") === undefined
      ? {}
      : { settingsRevision: result.settingsRevision as number }),
    ...(result.errorCode === undefined
      ? {}
      : { errorCode: result.errorCode as CoreSyncView["errorCode"] }),
    ...(result.action === undefined ? {} : { action: result.action as CoreSyncView["action"] }),
    ...(result.shared === undefined
      ? {}
      : { shared: parseSettings(result.shared, "response.shared") }),
    override: parseOverride(result.override, "response.override"),
    effective: parseSettings(result.effective, "response.effective"),
  };
}

export const CORE_SYNC_ROUTES = {
  status: "/api/sync/status",
  connect: "/api/sync/connect",
  cancel: "/api/sync/connect/cancel",
  disconnect: "/api/sync/disconnect",
  syncNow: "/api/sync/now",
  sources: "/api/sync/sources",
  override: "/api/sync/override",
} as const;
