import { type ProductTarget, isProductTarget } from "./platform.ts";

export type PayloadRelease = {
  schemaVersion: 1;
  product: "Cinba";
  version: string;
  revision: string;
  protocolVersion: number;
  dataFormatVersion: number;
  target: ProductTarget;
  nodeVersion: string;
};

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const REVISION = /^[0-9a-f]{40}$/;
const VERSION_NUMBER = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))*$/;

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

export function parsePayloadRelease(value: unknown): PayloadRelease {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("product release must be an object");
  }
  const parsed = value as Record<string, unknown>;
  const expected = [
    "schemaVersion",
    "product",
    "version",
    "revision",
    "protocolVersion",
    "dataFormatVersion",
    "target",
    "nodeVersion",
  ];
  const unknown = Object.keys(parsed).find((key) => !expected.includes(key));
  if (unknown) {
    throw new Error(`product release contains unknown field ${unknown}`);
  }
  const missing = expected.find((key) => !Object.hasOwn(parsed, key));
  if (missing) {
    throw new Error(`product release is missing field ${missing}`);
  }
  if (parsed.schemaVersion !== 1 || parsed.product !== "Cinba") {
    throw new Error("product release has an unsupported identity");
  }
  if (typeof parsed.version !== "string" || !SEMVER.test(parsed.version)) {
    throw new Error("product release version must be SemVer without a leading v");
  }
  if (typeof parsed.revision !== "string" || !REVISION.test(parsed.revision)) {
    throw new Error("product release revision must be a full lowercase Git commit");
  }
  if (!isProductTarget(parsed.target)) {
    throw new Error("product release target is not supported");
  }
  if (typeof parsed.nodeVersion !== "string" || !VERSION_NUMBER.test(parsed.nodeVersion)) {
    throw new Error("product release nodeVersion must be a dotted numeric version");
  }
  return {
    schemaVersion: 1,
    product: "Cinba",
    version: parsed.version,
    revision: parsed.revision,
    protocolVersion: positiveInteger(parsed.protocolVersion, "product release protocolVersion"),
    dataFormatVersion: positiveInteger(
      parsed.dataFormatVersion,
      "product release dataFormatVersion",
    ),
    target: parsed.target,
    nodeVersion: parsed.nodeVersion,
  };
}
