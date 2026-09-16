export {
  CredentialDecryptionError,
  assertCredentialKey,
  decryptCredential,
  encryptCredential,
  generateCredentialKey,
  hashSecret,
  verifySecret,
} from "./security/credentials.ts";
export type { CredentialEnvelope, SecretHash } from "./security/credentials.ts";
export { AttemptLimiter } from "./security/rate-limiter.ts";
export type { AttemptLimiterOptions } from "./security/rate-limiter.ts";
export {
  ADMIN_SESSION_COOKIE,
  AdministratorSessions,
  clearSessionCookie,
  createSessionCookie,
  sessionIdFromCookie,
} from "./security/sessions.ts";
export type { AdministratorSession, AdministratorSessionsOptions } from "./security/sessions.ts";
export { createAdministratorAuthHandler } from "./routes/administrator-auth-routes.ts";
export { createSyncApiHandler } from "./routes/sync-api-routes.ts";
export type { SyncAccessLog } from "./routes/sync-api-routes.ts";
export { createSyncWebStaticHandler } from "./routes/sync-web-static.ts";
export { AdministratorAuthService } from "./services/administrator-auth.ts";
export type {
  AuthenticationFailure,
  AuthenticationResult,
  AuthenticationSuccess,
  CookieMode,
  RequestSecurity,
} from "./services/administrator-auth.ts";
export { replaceJsonAtomically, writePrivateFileOnce } from "./store/atomic-json-store.ts";
export type { AtomicWriteOptions } from "./store/atomic-json-store.ts";
export { parseCredentialEnvelope, parseSecretHash, parseSyncState } from "./store/schema.ts";
export type {
  StoredCore,
  StoredEnrollment,
  StoredSettingsHistoryEntry,
  SyncState,
} from "./store/schema.ts";
export {
  CoreAuthenticationError,
  createSyncStore,
  EnrollmentAuthenticationError,
  SettingsConflictError,
  SyncMaintenanceError,
  SyncStoreUnavailableError,
} from "./store/sync-store.ts";
export type { SyncStore, SyncStoreOptions } from "./store/sync-store.ts";
export {
  backupSyncState,
  inspectSyncState,
  restoreSyncState,
  syncMaintenancePath,
} from "./services/backup-service.ts";
export type { SyncStateStatus } from "./services/backup-service.ts";
export { createSyncServer, defaultSyncStateDirectory, runSyncServer } from "./server.ts";
export type { SyncServerOptions } from "./server.ts";
