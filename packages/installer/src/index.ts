export {
  PRODUCT_TARGETS,
  PRODUCT_TARGET_DEFINITIONS,
  compareDottedVersions,
  isProductTarget,
  productTargetFor,
  requireProductTarget,
} from "./platform.ts";
export type {
  MinimumSystemRequirement,
  ProductTarget,
  ProductTargetDefinition,
} from "./platform.ts";
export { parseReleaseManifest } from "./manifest.ts";
export type {
  LinuxMinimumSystem,
  MacosMinimumSystem,
  ReleaseArtifact,
  ReleaseManifest,
  WindowsMinimumSystem,
} from "./manifest.ts";
export {
  createArtifactInventory,
  parseArtifactInventory,
  verifyArtifactInventory,
} from "./inventory.ts";
export type {
  ArtifactInventory,
  InventoryIdentity,
  InventoryFile,
  InventoryProblem,
  InventoryVerification,
} from "./inventory.ts";
export { PRODUCT_IDENTITIES, resolveProductPaths } from "./paths.ts";
export type {
  ProductIdentity,
  ProductIdentityDefinition,
  ProductPaths,
  ResolveProductPathsOptions,
} from "./paths.ts";
export {
  clearCurrentRelease,
  currentPointerPath,
  parseCurrentReleasePointer,
  parseInstallationTransaction,
  readCurrentRelease,
  readInstallationTransaction,
  releasePath,
  transactionStatePath,
  writeCurrentRelease,
  writeInstallationTransaction,
} from "./installation-store.ts";
export type {
  CurrentReleasePointer,
  InstallationFailure,
  InstallationLayout,
  InstallationPhase,
  InstallationTransaction,
  InstalledRelease,
} from "./installation-store.ts";
export { acquireInstallationLock } from "./installation-lock.ts";
export { activateCandidate, stageCandidate } from "./transaction.ts";
export type { ActivateCandidateOptions, StageCandidateOptions } from "./transaction.ts";
