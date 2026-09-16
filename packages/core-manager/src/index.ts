export { createLocalCoreConfig } from "./config.ts";
export {
  ensureLocalCore,
  inspectLocalCore,
  normalizeLocalCoreLifetime,
  resolveLocalCoreRevision,
  stopLocalCore,
} from "./core-manager.ts";
export type { LocalCoreConfig } from "./config.ts";
export type {
  EnsureLocalCoreOptions,
  LocalCoreStatus,
  NormalizeLocalCoreOptions,
  StopLocalCoreOptions,
} from "./core-manager.ts";
