export const PRODUCT_TARGETS = ["windows-x64", "macos-arm64", "linux-x64-gnu"] as const;

export type ProductTarget = (typeof PRODUCT_TARGETS)[number];

export type MinimumSystemRequirement =
  | { platform: "windows"; version: string }
  | { platform: "macos"; version: string }
  | { platform: "linux-gnu"; kernel: string; glibc: string };

export type ProductTargetDefinition = {
  target: ProductTarget;
  nodePlatform: NodeJS.Platform;
  nodeArchitecture: NodeJS.Architecture;
  artifactExtension: string;
  minimumSystem: MinimumSystemRequirement;
};

export const PRODUCT_TARGET_DEFINITIONS: Readonly<Record<ProductTarget, ProductTargetDefinition>> =
  {
    "windows-x64": {
      target: "windows-x64",
      nodePlatform: "win32",
      nodeArchitecture: "x64",
      artifactExtension: ".exe",
      minimumSystem: { platform: "windows", version: "10.0" },
    },
    "macos-arm64": {
      target: "macos-arm64",
      nodePlatform: "darwin",
      nodeArchitecture: "arm64",
      artifactExtension: ".dmg",
      minimumSystem: { platform: "macos", version: "13.5" },
    },
    "linux-x64-gnu": {
      target: "linux-x64-gnu",
      nodePlatform: "linux",
      nodeArchitecture: "x64",
      artifactExtension: ".tar.gz",
      minimumSystem: { platform: "linux-gnu", kernel: "4.18", glibc: "2.28" },
    },
  };

export function isProductTarget(value: unknown): value is ProductTarget {
  return typeof value === "string" && PRODUCT_TARGETS.includes(value as ProductTarget);
}

export function compareDottedVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

export function productTargetFor(
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
): ProductTarget | undefined {
  return PRODUCT_TARGETS.find((target) => {
    const definition = PRODUCT_TARGET_DEFINITIONS[target];
    return definition.nodePlatform === platform && definition.nodeArchitecture === architecture;
  });
}

export function requireProductTarget(
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
): ProductTarget {
  const target = productTargetFor(platform, architecture);
  if (!target) {
    throw new Error(`Cinba does not support ${platform}/${architecture}`);
  }
  return target;
}
