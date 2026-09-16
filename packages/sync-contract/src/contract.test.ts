import assert from "node:assert/strict";
import test from "node:test";
import {
  type Parser,
  parseAdministratorAuthenticated,
  parseAdministratorLoginRequest,
  parseAdministratorSetupRequest,
  parseAdministratorStatus,
  parseBackupMetadata,
  parseCapabilitiesReport,
  parseConnectedCoreList,
  parseCoreCapabilities,
  parseCoreReportAccepted,
  parseCredentialStatus,
  parseCredentialStatusList,
  parseEnrollmentCreated,
  parseEnrollmentDecisionRequest,
  parseEnrollmentRequest,
  parseEnrollmentStatus,
  parseModelCatalog,
  parsePendingEnrollmentList,
  parsePutCredentialRequest,
  parseRollbackSettingsRequest,
  parseServerOverview,
  parseSettingsHistory,
  parseSharedSettings,
  parseSharedSettingsView,
  parseSyncErrorResponse,
  parseSyncSnapshot,
  parseUpdateSharedSettingsRequest,
} from "./index.ts";

const settings = {
  version: 1,
  defaultModel: { provider: "deepseek", id: "deepseek-chat" },
  webTools: { searchPrimary: "exa" },
};

const validDocuments: Array<[string, Parser<unknown>, unknown]> = [
  ["Administrator status", parseAdministratorStatus, { version: 1, state: "setup-required" }],
  [
    "Authenticated administrator status",
    parseAdministratorStatus,
    { version: 1, state: "authenticated", csrfToken: "csrf-token" },
  ],
  [
    "Administrator setup",
    parseAdministratorSetupRequest,
    { version: 1, setupCode: "setup-code", password: "strong-password" },
  ],
  [
    "Administrator login",
    parseAdministratorLoginRequest,
    { version: 1, password: "strong-password" },
  ],
  [
    "Administrator authenticated",
    parseAdministratorAuthenticated,
    {
      version: 1,
      state: "authenticated",
      csrfToken: "csrf-token",
      expiresAt: "2026-09-16T00:00:00.000Z",
    },
  ],
  ["Shared Settings", parseSharedSettings, settings],
  [
    "Server overview",
    parseServerOverview,
    {
      version: 1,
      serverId: "server-id",
      settingsRevision: 2,
      syncRevision: 3,
      connectedCoreCount: 1,
      pendingEnrollmentCount: 0,
      recentSyncErrors: [{ coreId: "core-id", coreName: "Core", code: "offline" }],
    },
  ],
  [
    "Shared Settings view",
    parseSharedSettingsView,
    { version: 1, settingsRevision: 2, syncRevision: 3, settings },
  ],
  [
    "Shared Settings update",
    parseUpdateSharedSettingsRequest,
    { version: 1, baseSettingsRevision: 2, settings },
  ],
  [
    "Credential status",
    parseCredentialStatus,
    { version: 1, provider: "deepseek", configured: true },
  ],
  [
    "Credential status list",
    parseCredentialStatusList,
    {
      version: 1,
      credentials: [{ version: 1, provider: "deepseek", configured: true }],
      syncRevision: 3,
    },
  ],
  ["Credential update", parsePutCredentialRequest, { version: 1, apiKey: "secret" }],
  [
    "Connected Core list",
    parseConnectedCoreList,
    {
      version: 1,
      cores: [
        {
          version: 1,
          id: "core-1",
          name: "Studio",
          platform: "windows",
          appVersion: "0.0.0",
          credentialSource: "sync",
          revoked: false,
        },
      ],
    },
  ],
  [
    "Settings history",
    parseSettingsHistory,
    {
      version: 1,
      entries: [
        {
          version: 1,
          settingsRevision: 2,
          syncRevision: 3,
          createdAt: "2026-09-16T00:00:00.000Z",
          settings,
        },
      ],
    },
  ],
  [
    "Settings rollback",
    parseRollbackSettingsRequest,
    { version: 1, baseSettingsRevision: 3, targetSettingsRevision: 1 },
  ],
  [
    "Backup metadata",
    parseBackupMetadata,
    {
      version: 1,
      serverId: "server-1",
      createdAt: "2026-09-16T00:00:00.000Z",
      settingsRevision: 2,
      syncRevision: 3,
      connectedCoreCount: 1,
      credentialCount: 2,
    },
  ],
  ["Enrollment decision", parseEnrollmentDecisionRequest, { version: 1, decision: "approve" }],
  [
    "Pending enrollment list",
    parsePendingEnrollmentList,
    {
      version: 1,
      enrollments: [
        {
          version: 1,
          id: "enrollment-1",
          name: "Studio",
          platform: "windows",
          appVersion: "0.0.0",
          credentialSource: "sync",
          createdAt: "2026-09-16T00:00:00.000Z",
          expiresAt: "2026-09-16T00:10:00.000Z",
        },
      ],
    },
  ],
  [
    "Model catalog",
    parseModelCatalog,
    {
      version: 1,
      models: [
        {
          model: { provider: "deepseek", id: "deepseek-chat" },
          supportedCoreIds: ["core-1"],
          unsupportedCoreIds: ["core-2"],
        },
      ],
    },
  ],
  [
    "Core capabilities",
    parseCoreCapabilities,
    {
      version: 1,
      providers: [{ id: "deepseek", name: "DeepSeek", authKind: "api-key" }],
      models: [{ provider: "deepseek", id: "deepseek-chat" }],
    },
  ],
  [
    "Enrollment request",
    parseEnrollmentRequest,
    {
      version: 1,
      name: "Studio",
      platform: "windows",
      appVersion: "0.0.0",
      credentialSource: "sync",
    },
  ],
  [
    "Enrollment created",
    parseEnrollmentCreated,
    {
      version: 1,
      enrollmentId: "enrollment-1",
      enrollmentSecret: "secret",
      expiresAt: "2026-09-16T00:00:00.000Z",
    },
  ],
  ["Enrollment pending", parseEnrollmentStatus, { version: 1, status: "pending" }],
  [
    "Enrollment approved",
    parseEnrollmentStatus,
    {
      version: 1,
      status: "approved",
      coreId: "core-1",
      coreCredential: "credential",
    },
  ],
  [
    "Snapshot",
    parseSyncSnapshot,
    {
      version: 1,
      syncRevision: 3,
      settingsRevision: 2,
      settings,
      credentials: { deepseek: "secret" },
    },
  ],
  [
    "Capabilities report",
    parseCapabilitiesReport,
    {
      version: 1,
      appVersion: "0.0.0",
      capabilities: { version: 1, providers: [], models: [] },
      currentSyncRevision: 3,
    },
  ],
  ["Core report response", parseCoreReportAccepted, { version: 1, accepted: true }],
  [
    "Error response",
    parseSyncErrorResponse,
    {
      version: 1,
      error: { code: "conflict", message: "Refresh and retry", retryable: false },
    },
  ],
];

for (const [name, parser, document] of validDocuments) {
  test(`${name} accepts its version 1 document`, () => {
    assert.doesNotThrow(() => parser(document));
  });

  test(`${name} rejects missing and unknown versions`, () => {
    const record = document as Record<string, unknown>;
    const { version: _version, ...missing } = record;
    assert.throws(() => parser(missing), /version/);
    assert.throws(() => parser({ ...record, version: 99 }), /version/);
  });
}

test("strict network schemas reject extra secret-bearing fields", () => {
  assert.throws(
    () =>
      parseCredentialStatus({
        version: 1,
        provider: "deepseek",
        configured: true,
        apiKey: "must-not-cross-this-boundary",
      }),
    /unexpected field/,
  );
  assert.throws(
    () =>
      parseCoreCapabilities({
        version: 1,
        providers: [],
        models: [],
        credentials: { deepseek: "must-not-cross-this-boundary" },
      }),
    /unexpected field/,
  );
});

test("required fields and bounded capability collections fail closed", () => {
  assert.throws(() => parseSharedSettings({ version: 1 }), /webTools/);
  assert.throws(
    () =>
      parseCoreCapabilities({
        version: 1,
        providers: Array.from({ length: 257 }, () => ({
          id: "provider",
          name: "Provider",
          authKind: "api-key",
        })),
        models: [],
      }),
    /at most 256/,
  );
});
