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
  createSyncStore,
  SettingsConflictError,
  SyncStoreUnavailableError,
} from "./store/sync-store.ts";
export type { SyncStore, SyncStoreOptions } from "./store/sync-store.ts";
