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
export { PRODUCT_IDENTITIES, resolveProductPaths } from "./paths.ts";
export type {
  ProductIdentity,
  ProductIdentityDefinition,
  ProductPaths,
  ResolveProductPathsOptions,
} from "./paths.ts";
