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
export { parsePayloadRelease } from "./payload-release.ts";
export type { PayloadRelease } from "./payload-release.ts";
export {
  createDataSnapshot,
  dataSnapshotExists,
  dataSnapshotPath,
  discardDataSnapshot,
  restoreDataSnapshot,
} from "./data-snapshot.ts";
export type { DataSnapshot, ProtectedDataRoot } from "./data-snapshot.ts";
export { cleanupInstallation } from "./cleanup.ts";
export type { InstallationCleanupResult } from "./cleanup.ts";
export { createUninstallPlan } from "./uninstall.ts";
export type {
  PurgeAuthorization,
  UninstallPlan,
  UninstallRequest,
  UninstallTarget,
  UninstallTargetKind,
} from "./uninstall.ts";
export {
  createDefaultServiceState,
  parseServiceState,
  readServiceState,
  serviceStatePath,
  writeServiceState,
} from "./services/service-state.ts";
export { createManagedServiceDefinitions } from "./services/definitions.ts";
export type { ManagedServiceDefinition, ServicePlatform } from "./services/definitions.ts";
export {
  inspectManagedService,
  recoverManagedServiceOperation,
  setManagedServiceMode,
} from "./services/service-manager.ts";
export {
  LinuxLingerRequiredError,
  createLinuxSystemdUserAdapter,
  enableLinuxLinger,
  inspectLinuxBackgroundSupport,
  renderSystemdUserUnit,
} from "./services/linux-systemd-user.ts";
export type {
  LinuxBackgroundSupport,
  RunServiceCommand,
  ServiceCommandResult,
} from "./services/linux-systemd-user.ts";
export {
  createWindowsScheduledTaskAdapter,
  renderWindowsScheduledTaskRegistration,
} from "./services/windows-task.ts";
export type { PowerShellResult, RunPowerShell } from "./services/windows-task.ts";
export {
  createMacosLaunchAgentAdapter,
  renderMacosLaunchAgent,
} from "./services/macos-launch-agent.ts";
export type { LaunchctlResult, RunLaunchctl } from "./services/macos-launch-agent.ts";
export type {
  ManagedServiceStatus,
  PlatformServiceAdapter,
  PlatformServiceSnapshot,
  ServiceAvailability,
  ServiceManagerOptions,
} from "./services/service-manager.ts";
export type {
  ServiceComponent,
  ServiceComponentRecord,
  ServiceFailure,
  ServiceMode,
  ServiceOperationPhase,
  ServiceState,
} from "./services/service-state.ts";
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
export {
  activateCandidate,
  recoverInterruptedInstallation,
  stageCandidate,
} from "./transaction.ts";
export type {
  ActivateCandidateOptions,
  RecoverInstallationOptions,
  StageCandidateOptions,
} from "./transaction.ts";
