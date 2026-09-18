import assert from "node:assert/strict";
import test from "node:test";
import { parseReleaseManifest } from "./manifest.ts";

const DIGEST = "ab".repeat(32);

function manifest(): unknown {
  return {
    schemaVersion: 1,
    product: "Cinba",
    version: "0.1.0",
    revision: "0123456789abcdef0123456789abcdef01234567",
    protocolVersion: 1,
    dataFormatVersion: 1,
    builtAt: "2026-09-17T12:00:00Z",
    artifacts: [
      {
        target: "windows-x64",
        fileName: "Cinba-0.1.0-windows-x64.exe",
        size: 101,
        sha256: DIGEST,
        minimumSystem: { version: "10.0" },
      },
      {
        target: "macos-arm64",
        fileName: "Cinba-0.1.0-macos-arm64.dmg",
        size: 102,
        sha256: DIGEST,
        minimumSystem: { version: "13.5" },
      },
      {
        target: "linux-x64-gnu",
        fileName: "Cinba-0.1.0-linux-x64-gnu.tar.gz",
        size: 103,
        sha256: DIGEST,
        minimumSystem: { kernel: "4.18", glibc: "2.28" },
      },
    ],
  };
}

test("parses one complete immutable-release manifest", () => {
  assert.deepEqual(parseReleaseManifest(manifest()), manifest());
});

test("requires exact top-level fields and schema version", () => {
  const extra = manifest() as Record<string, unknown>;
  extra.channel = "stable";
  assert.throws(() => parseReleaseManifest(extra), /unknown field channel/);

  const future = manifest() as Record<string, unknown>;
  future.schemaVersion = 2;
  assert.throws(() => parseReleaseManifest(future), /schemaVersion must be 1/);
});

test("requires SemVer, a full revision, positive versions, and an ISO timestamp", () => {
  for (const [field, value, message] of [
    ["version", "v0.1.0", /SemVer without a leading v/],
    ["revision", "abc123", /full lowercase Git commit/],
    ["protocolVersion", 0, /protocolVersion must be a positive integer/],
    ["dataFormatVersion", -1, /dataFormatVersion must be a positive integer/],
    ["builtAt", "September 17", /ISO UTC timestamp/],
  ] as const) {
    const valueWithError = manifest() as Record<string, unknown>;
    valueWithError[field] = value;
    assert.throws(() => parseReleaseManifest(valueWithError), message);
  }
});

test("requires one safe artifact for every supported target", () => {
  const missing = manifest() as { artifacts: unknown[] };
  missing.artifacts.pop();
  assert.throws(() => parseReleaseManifest(missing), /missing product target linux-x64-gnu/);

  const duplicate = manifest() as { artifacts: Array<Record<string, unknown>> };
  duplicate.artifacts[2]!.target = "windows-x64";
  duplicate.artifacts[2]!.fileName = "Cinba-duplicate.exe";
  duplicate.artifacts[2]!.minimumSystem = { version: "10.0" };
  assert.throws(() => parseReleaseManifest(duplicate), /duplicate product target/);

  const unsafe = manifest() as { artifacts: Array<Record<string, unknown>> };
  unsafe.artifacts[0]!.fileName = "../Cinba.exe";
  assert.throws(() => parseReleaseManifest(unsafe), /plain file name/);
});

test("validates target-specific artifacts and minimum systems", () => {
  const wrongExtension = manifest() as { artifacts: Array<Record<string, unknown>> };
  wrongExtension.artifacts[1]!.fileName = "Cinba.zip";
  assert.throws(() => parseReleaseManifest(wrongExtension), /must end with \.dmg/);

  const wrongHash = manifest() as { artifacts: Array<Record<string, unknown>> };
  wrongHash.artifacts[0]!.sha256 = DIGEST.toUpperCase();
  assert.throws(() => parseReleaseManifest(wrongHash), /lowercase SHA-256/);

  const missingGlibc = manifest() as { artifacts: Array<Record<string, unknown>> };
  missingGlibc.artifacts[2]!.minimumSystem = { kernel: "4.18" };
  assert.throws(() => parseReleaseManifest(missingGlibc), /missing field glibc/);

  const unsupportedMac = manifest() as { artifacts: Array<Record<string, unknown>> };
  unsupportedMac.artifacts[1]!.minimumSystem = { version: "12.0" };
  assert.throws(() => parseReleaseManifest(unsupportedMac), /lower than Cinba's supported/);

  const unsupportedGlibc = manifest() as { artifacts: Array<Record<string, unknown>> };
  unsupportedGlibc.artifacts[2]!.minimumSystem = { kernel: "4.18", glibc: "2.27" };
  assert.throws(() => parseReleaseManifest(unsupportedGlibc), /lower than Cinba's supported/);
});
