import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  type ArtifactInventory,
  parseArtifactInventory,
  verifyArtifactInventory,
} from "./inventory.ts";
import { type PayloadRelease, parsePayloadRelease } from "./payload-release.ts";
import { type ProductTarget, isProductTarget } from "./platform.ts";

export type ReleaseBundleKind = "desktop" | "headless";

export type ReleaseBundleMetadata = {
  schemaVersion: 1;
  product: "Cinba";
  version: string;
  revision: string;
  target: ProductTarget;
  kind: ReleaseBundleKind;
};

export type VerifiedReleaseBundle = {
  rootDirectory: string;
  payloadDirectory: string;
  launcher: string;
  desktopApplication: string | null;
  metadata: ReleaseBundleMetadata;
  payload: PayloadRelease;
  inventory: ArtifactInventory;
};

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const REVISION = /^[0-9a-f]{40}$/;

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const unknown = Object.keys(value).find((key) => !expected.includes(key));
  if (unknown) {
    throw new Error(`release bundle contains unknown field ${unknown}`);
  }
  const missing = expected.find((key) => !Object.hasOwn(value, key));
  if (missing) {
    throw new Error(`release bundle is missing field ${missing}`);
  }
}

export function parseReleaseBundleMetadata(value: unknown): ReleaseBundleMetadata {
  const parsed = record(value, "release bundle");
  exactKeys(parsed, ["schemaVersion", "product", "version", "revision", "target", "kind"]);
  if (parsed.schemaVersion !== 1 || parsed.product !== "Cinba") {
    throw new Error("release bundle has an unsupported identity");
  }
  if (typeof parsed.version !== "string" || !SEMVER.test(parsed.version)) {
    throw new Error("release bundle version must be SemVer without a leading v");
  }
  if (typeof parsed.revision !== "string" || !REVISION.test(parsed.revision)) {
    throw new Error("release bundle revision must be a full lowercase Git commit");
  }
  if (!isProductTarget(parsed.target)) {
    throw new Error("release bundle target is not supported");
  }
  const expectedKind = parsed.target === "linux-x64-gnu" ? "headless" : "desktop";
  if (parsed.kind !== expectedKind) {
    throw new Error(`release bundle ${parsed.target} must use kind ${expectedKind}`);
  }
  return {
    schemaVersion: 1,
    product: "Cinba",
    version: parsed.version,
    revision: parsed.revision,
    target: parsed.target,
    kind: expectedKind,
  };
}

function sameIdentity(
  left: Pick<ReleaseBundleMetadata, "version" | "revision" | "target">,
  right: Pick<ReleaseBundleMetadata, "version" | "revision" | "target">,
): boolean {
  return (
    left.version === right.version &&
    left.revision === right.revision &&
    left.target === right.target
  );
}

async function requireRegularFile(path: string, description: string): Promise<void> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`${description} must be a regular file`);
  }
}

export async function verifyReleaseBundle(
  rootDirectory: string,
  expectedTarget: ProductTarget,
): Promise<VerifiedReleaseBundle> {
  if (!isAbsolute(rootDirectory)) {
    throw new Error("release bundle rootDirectory must be absolute");
  }
  const root = resolve(rootDirectory);
  const metadata = parseReleaseBundleMetadata(
    JSON.parse(await readFile(join(root, "bundle.json"), "utf8")) as unknown,
  );
  if (metadata.target !== expectedTarget) {
    throw new Error(`release bundle target ${metadata.target} does not match ${expectedTarget}`);
  }
  const inventory = parseArtifactInventory(
    JSON.parse(await readFile(join(root, "bundle-inventory.json"), "utf8")) as unknown,
  );
  if (!sameIdentity(metadata, inventory)) {
    throw new Error("release bundle metadata does not match its inventory");
  }
  const bundleVerification = await verifyArtifactInventory(root, inventory, {
    inventoryFileName: "bundle-inventory.json",
  });
  if (!bundleVerification.valid) {
    throw new Error(
      `release bundle inventory verification failed: ${JSON.stringify(bundleVerification.problems)}`,
    );
  }

  const payloadDirectory = join(root, "payload");
  const payload = parsePayloadRelease(
    JSON.parse(await readFile(join(payloadDirectory, "release.json"), "utf8")) as unknown,
  );
  if (!sameIdentity(metadata, payload)) {
    throw new Error("release bundle metadata does not match its payload");
  }
  const payloadInventory = parseArtifactInventory(
    JSON.parse(await readFile(join(payloadDirectory, "inventory.json"), "utf8")) as unknown,
  );
  if (!sameIdentity(metadata, payloadInventory)) {
    throw new Error("release bundle metadata does not match the payload inventory");
  }
  const payloadVerification = await verifyArtifactInventory(payloadDirectory, payloadInventory);
  if (!payloadVerification.valid) {
    throw new Error(
      `release payload inventory verification failed: ${JSON.stringify(payloadVerification.problems)}`,
    );
  }

  const launcher = join(
    root,
    "launcher",
    metadata.target === "windows-x64" ? "cinba.exe" : "cinba",
  );
  await requireRegularFile(launcher, "Cinba launcher");

  let desktopApplication: string | null = null;
  if (metadata.target === "windows-x64") {
    desktopApplication = join(root, "desktop", "Cinba.exe");
    await requireRegularFile(desktopApplication, "Windows Desktop application");
  } else if (metadata.target === "macos-arm64") {
    desktopApplication = join(root, "desktop", "Cinba.app");
    await requireRegularFile(
      join(desktopApplication, "Contents", "MacOS", "Cinba"),
      "macOS Desktop executable",
    );
  }
  return {
    rootDirectory: root,
    payloadDirectory,
    launcher,
    desktopApplication,
    metadata,
    payload,
    inventory,
  };
}
