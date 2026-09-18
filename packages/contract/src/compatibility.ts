export const CORE_PROTOCOL_VERSION = 1;

export const CORE_CAPABILITIES = [
  "sessions",
  "models",
  "credentials",
  "project-trust",
  "web-tools",
  "sync-settings",
] as const;

export type CoreCapability = (typeof CORE_CAPABILITIES)[number];

export type CoreHello = {
  productVersion: string;
  revision: string;
  protocolVersion: number;
  capabilities: CoreCapability[];
};

export type CoreCompatibility =
  { compatible: true } | { compatible: false; reason: "protocol" | "capability"; detail: string };

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const REVISION = /^(?:[0-9a-f]{7,40}|unknown)$/;

export function isCoreCapability(value: unknown): value is CoreCapability {
  return typeof value === "string" && CORE_CAPABILITIES.includes(value as CoreCapability);
}

export function parseCoreHello(value: unknown): CoreHello | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const hello = value as Record<string, unknown>;
  const fields = ["productVersion", "revision", "protocolVersion", "capabilities"];
  if (
    Object.keys(hello).some((field) => !fields.includes(field)) ||
    fields.some((field) => !Object.hasOwn(hello, field)) ||
    typeof hello.productVersion !== "string" ||
    !SEMVER.test(hello.productVersion) ||
    typeof hello.revision !== "string" ||
    !REVISION.test(hello.revision) ||
    !Number.isSafeInteger(hello.protocolVersion) ||
    (hello.protocolVersion as number) < 1 ||
    !Array.isArray(hello.capabilities) ||
    !hello.capabilities.every(isCoreCapability) ||
    new Set(hello.capabilities).size !== hello.capabilities.length
  ) {
    return undefined;
  }
  return {
    productVersion: hello.productVersion,
    revision: hello.revision,
    protocolVersion: hello.protocolVersion as number,
    capabilities: [...hello.capabilities],
  };
}

export function assessCoreCompatibility(
  hello: CoreHello,
  requirements: {
    protocolVersion?: number;
    capabilities?: readonly CoreCapability[];
  } = {},
): CoreCompatibility {
  const protocolVersion = requirements.protocolVersion ?? CORE_PROTOCOL_VERSION;
  if (hello.protocolVersion !== protocolVersion) {
    return {
      compatible: false,
      reason: "protocol",
      detail: `Core protocol ${hello.protocolVersion} is incompatible with client protocol ${protocolVersion}`,
    };
  }
  const missing = (requirements.capabilities ?? []).find(
    (capability) => !hello.capabilities.includes(capability),
  );
  if (missing) {
    return {
      compatible: false,
      reason: "capability",
      detail: `Core does not provide required capability ${missing}`,
    };
  }
  return { compatible: true };
}
