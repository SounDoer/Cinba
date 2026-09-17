import {
  PRODUCT_TARGETS,
  PRODUCT_TARGET_DEFINITIONS,
  type ProductTarget,
  compareDottedVersions,
  isProductTarget,
} from "./platform.ts";

export type WindowsMinimumSystem = { version: string };
export type MacosMinimumSystem = { version: string };
export type LinuxMinimumSystem = { kernel: string; glibc: string };

export type ReleaseArtifact =
  | {
      target: "windows-x64";
      fileName: string;
      size: number;
      sha256: string;
      minimumSystem: WindowsMinimumSystem;
    }
  | {
      target: "macos-arm64";
      fileName: string;
      size: number;
      sha256: string;
      minimumSystem: MacosMinimumSystem;
    }
  | {
      target: "linux-x64-gnu";
      fileName: string;
      size: number;
      sha256: string;
      minimumSystem: LinuxMinimumSystem;
    };

export type ReleaseManifest = {
  schemaVersion: 1;
  product: "Cinba";
  version: string;
  revision: string;
  protocolVersion: number;
  dataFormatVersion: number;
  publishedAt: string;
  artifacts: ReleaseArtifact[];
};

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const VERSION_NUMBER = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const SAFE_FILE_NAME = /^[^/\\\0]+$/;

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
): void {
  const expectedSet = new Set(expected);
  const unknown = Object.keys(value).filter((key) => !expectedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${context} contains unknown field ${unknown[0]}`);
  }
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    throw new Error(`${context} is missing field ${missing[0]}`);
  }
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

function versionNumber(value: unknown, field: string): string {
  const parsed = string(value, field);
  if (!VERSION_NUMBER.test(parsed)) {
    throw new Error(`${field} must be a dotted numeric version`);
  }
  return parsed;
}

function minimumSystem(
  value: unknown,
  target: ProductTarget,
  context: string,
): WindowsMinimumSystem | MacosMinimumSystem | LinuxMinimumSystem {
  const parsed = record(value, context);
  if (target === "linux-x64-gnu") {
    exactKeys(parsed, ["kernel", "glibc"], context);
    const minimum = {
      kernel: versionNumber(parsed.kernel, `${context}.kernel`),
      glibc: versionNumber(parsed.glibc, `${context}.glibc`),
    };
    const baseline = PRODUCT_TARGET_DEFINITIONS[target].minimumSystem;
    if (
      baseline.platform !== "linux-gnu" ||
      compareDottedVersions(minimum.kernel, baseline.kernel) < 0 ||
      compareDottedVersions(minimum.glibc, baseline.glibc) < 0
    ) {
      throw new Error(`${context} is lower than Cinba's supported platform baseline`);
    }
    return minimum;
  }
  exactKeys(parsed, ["version"], context);
  const minimum = { version: versionNumber(parsed.version, `${context}.version`) };
  const baseline = PRODUCT_TARGET_DEFINITIONS[target].minimumSystem;
  if (
    baseline.platform === "linux-gnu" ||
    compareDottedVersions(minimum.version, baseline.version) < 0
  ) {
    throw new Error(`${context} is lower than Cinba's supported platform baseline`);
  }
  return minimum;
}

function artifact(value: unknown, index: number): ReleaseArtifact {
  const context = `artifacts[${index}]`;
  const parsed = record(value, context);
  exactKeys(parsed, ["target", "fileName", "size", "sha256", "minimumSystem"], context);
  if (!isProductTarget(parsed.target)) {
    throw new Error(`${context}.target is not a supported product target`);
  }
  const target = parsed.target;
  const fileName = string(parsed.fileName, `${context}.fileName`);
  if (!SAFE_FILE_NAME.test(fileName) || fileName === "." || fileName === "..") {
    throw new Error(`${context}.fileName must be a plain file name`);
  }
  if (!fileName.endsWith(PRODUCT_TARGET_DEFINITIONS[target].artifactExtension)) {
    throw new Error(
      `${context}.fileName must end with ${PRODUCT_TARGET_DEFINITIONS[target].artifactExtension}`,
    );
  }
  const sha256 = string(parsed.sha256, `${context}.sha256`);
  if (!SHA256.test(sha256)) {
    throw new Error(`${context}.sha256 must be a lowercase SHA-256 digest`);
  }
  const common = {
    fileName,
    size: positiveInteger(parsed.size, `${context}.size`),
    sha256,
  };
  const system = minimumSystem(parsed.minimumSystem, target, `${context}.minimumSystem`);
  if (target === "windows-x64") {
    return { target, ...common, minimumSystem: system as WindowsMinimumSystem };
  }
  if (target === "macos-arm64") {
    return { target, ...common, minimumSystem: system as MacosMinimumSystem };
  }
  return { target, ...common, minimumSystem: system as LinuxMinimumSystem };
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  const parsed = record(value, "release manifest");
  exactKeys(
    parsed,
    [
      "schemaVersion",
      "product",
      "version",
      "revision",
      "protocolVersion",
      "dataFormatVersion",
      "publishedAt",
      "artifacts",
    ],
    "release manifest",
  );
  if (parsed.schemaVersion !== 1) {
    throw new Error("release manifest schemaVersion must be 1");
  }
  if (parsed.product !== "Cinba") {
    throw new Error('release manifest product must be "Cinba"');
  }
  const version = string(parsed.version, "release manifest version");
  if (!SEMVER.test(version)) {
    throw new Error("release manifest version must be SemVer without a leading v");
  }
  const revision = string(parsed.revision, "release manifest revision");
  if (!REVISION.test(revision)) {
    throw new Error("release manifest revision must be a full lowercase Git commit");
  }
  const publishedAt = string(parsed.publishedAt, "release manifest publishedAt");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(publishedAt) ||
    Number.isNaN(Date.parse(publishedAt))
  ) {
    throw new Error("release manifest publishedAt must be an ISO UTC timestamp");
  }
  if (!Array.isArray(parsed.artifacts)) {
    throw new Error("release manifest artifacts must be an array");
  }
  const artifacts = parsed.artifacts.map(artifact);
  const targets = new Set(artifacts.map((entry) => entry.target));
  if (targets.size !== artifacts.length) {
    throw new Error("release manifest contains a duplicate product target");
  }
  const missing = PRODUCT_TARGETS.find((target) => !targets.has(target));
  if (missing) {
    throw new Error(`release manifest is missing product target ${missing}`);
  }
  return {
    schemaVersion: 1,
    product: "Cinba",
    version,
    revision,
    protocolVersion: positiveInteger(parsed.protocolVersion, "release manifest protocolVersion"),
    dataFormatVersion: positiveInteger(
      parsed.dataFormatVersion,
      "release manifest dataFormatVersion",
    ),
    publishedAt,
    artifacts,
  };
}
