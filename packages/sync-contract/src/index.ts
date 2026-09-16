export {
  parseCapabilitiesReport,
  parseCoreCapabilities,
  parseCoreReportAccepted,
  parseEnrollmentCreated,
  parseEnrollmentRequest,
  parseEnrollmentStatus,
  parseSyncSnapshot,
} from "./core.ts";
export type {
  CapabilitiesReport,
  CoreCapabilities,
  CorePlatform,
  CoreReportAccepted,
  CredentialSource,
  EnrollmentCreated,
  EnrollmentRequest,
  EnrollmentStatus,
  ProviderCapability,
  SyncSnapshot,
} from "./core.ts";
export { parseSyncErrorResponse, SYNC_ERROR_CODES } from "./errors.ts";
export type { SyncErrorCode, SyncErrorResponse } from "./errors.ts";
export {
  parseBackupMetadata,
  parseConnectedCoreList,
  parseCredentialStatus,
  parseCredentialStatusList,
  parseEnrollmentDecisionRequest,
  parsePutCredentialRequest,
  parseRollbackSettingsRequest,
  parseSettingsHistory,
  parseSharedSettings,
  parseSharedSettingsView,
  parseUpdateSharedSettingsRequest,
} from "./management.ts";
export type {
  BackupMetadata,
  ConnectedCore,
  ConnectedCoreList,
  CredentialStatus,
  CredentialStatusList,
  EnrollmentDecisionRequest,
  PutCredentialRequest,
  RollbackSettingsRequest,
  SettingsHistory,
  SettingsHistoryEntry,
  SharedSettings,
  SharedSettingsView,
  UpdateSharedSettingsRequest,
} from "./management.ts";
export { SyncSchemaError } from "./schemas.ts";
export type { ModelRef, Parser } from "./schemas.ts";

export const SYNC_ROUTES = {
  health: "/health",
  management: {
    settings: "/api/management/settings",
    credentials: "/api/management/credentials",
    cores: "/api/management/cores",
    enrollments: "/api/management/enrollments",
    history: "/api/management/history",
    rollback: "/api/management/history/rollback",
    backupMetadata: "/api/management/backup/metadata",
  },
  core: {
    enrollments: "/api/core/enrollments",
    snapshot: "/api/core/snapshot",
    capabilities: "/api/core/capabilities",
  },
} as const;
