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
export {
  PRODUCT_DATA_FORMAT_VERSION,
  PRODUCT_PROTOCOL_VERSION,
  RELEASE_MANIFEST_FILE_NAME,
} from "./product-release-constants.ts";
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
export { parseReleaseBundleMetadata, verifyReleaseBundle } from "./release-bundle.ts";
export type {
  ReleaseBundleKind,
  ReleaseBundleMetadata,
  VerifiedReleaseBundle,
} from "./release-bundle.ts";
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
export { createUninstallPlan, executeUninstallPlan } from "./uninstall.ts";
export type {
  PurgeAuthorization,
  UninstallPlan,
  UninstallRequest,
  UninstallResult,
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
export {
  CINBA_RELEASE_API,
  CINBA_RELEASE_MANIFEST_ASSET,
  UPDATE_DISCOVERY_FAILURE_CODE,
  UpdateDiscoveryFailureError,
  discoverCinbaUpdate,
  parseUpdateDiscoveryFailure,
} from "./update-discovery.ts";
export type {
  UpdateDiscovery,
  UpdateDiscoveryFailure,
  UpdateDiscoveryFailureDetails,
} from "./update-discovery.ts";
export { downloadUpdateCandidate } from "./update-download.ts";
export type { DownloadedUpdate } from "./update-download.ts";
export {
  AUTOMATIC_UPDATE_CHECK_INTERVAL_MS,
  automaticUpdateCheckIsDue,
  parseUpdateState,
  readUpdateState,
  recordUpdateInstallationResult,
  updateStatePath,
  writeUpdateState,
} from "./update-state.ts";
export { prepareProductUpdate } from "./update-operation.ts";
export { cleanupUpdateCandidateCache } from "./update-cache.ts";
export {
  acquireProductUpdateLease,
  claimTransferredProductUpdateLease,
  runWithProductUpdateLease,
} from "./update-lock.ts";
export type { ProductUpdateLease } from "./update-lock.ts";
export type { UpdateCandidate, UpdateFailure, UpdatePhase, UpdateState } from "./update-state.ts";
export {
  UPDATE_HANDOFF_TTL_MS,
  assertUpdateHandoffMatchesReadyState,
  claimUpdateHandoff,
  createUpdateHandoff,
  parseUpdateHandoff,
  reapClaimedUpdateHandoffs,
  removeUpdateHandoff,
  updateHandoffPath,
  writeUpdateHandoff,
  writeUpdateHandoffRecoveringStale,
} from "./update-handoff.ts";
export type { UpdateHandoff } from "./update-handoff.ts";
export type { ClaimedUpdateHandoffReapResult } from "./update-handoff.ts";
export { installPreparedUpdateArtifact } from "./update-installation.ts";
export type {
  RunUpdateInstaller,
  UpdateInstallerResult,
  VerifyUpdateArtifact,
} from "./update-installation.ts";
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
export { installReleaseBundle } from "./bundle-installation.ts";
export type { InstallReleaseBundleOptions, PreparedStableFiles } from "./bundle-installation.ts";
export { prepareStableProductFiles, recoverStableProductFiles } from "./stable-files.ts";
export type { StableFileInstallMode } from "./stable-files.ts";
export { installProductBundle, verifyInstalledProductRelease } from "./product-installation.ts";
export { configurePosixLauncherPath, removePosixLauncherPathBlock } from "./shell-path.ts";
export type { PosixPathConfiguration } from "./shell-path.ts";
export { configureWindowsUserPath, removeWindowsUserPath } from "./windows-path.ts";
export type { PowerShellPathResult, RunPathPowerShell } from "./windows-path.ts";
export {
  configureWindowsProductIntegration,
  removeWindowsProductIntegration,
} from "./windows-integration.ts";
export type { RunWindowsIntegrationPowerShell } from "./windows-integration.ts";
export {
  CINBA_PRODUCT_LAUNCHER_PATH,
  CINBA_PRODUCT_LAUNCHER_PID,
  createInstalledProductEnvironment,
  parseInstalledProductLauncher,
  parseProductLauncherProcessId,
  resolveInstalledProductCommand,
  runInstalledProductCommand,
} from "./stable-launcher.ts";
export type { InstalledProductCommand, InstalledProductLauncher } from "./stable-launcher.ts";
export {
  activateCandidate,
  discardReadyCandidate,
  recoverInterruptedInstallation,
  stageCandidate,
} from "./transaction.ts";
export type {
  ActivateCandidateOptions,
  RecoverInstallationOptions,
  StageCandidateOptions,
} from "./transaction.ts";
