import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { createMacosArtifactConfiguration } from "./build-macos-artifact.ts";

test("the macOS DMG embeds one self-installing application without a system Applications link", () => {
  const bundleDirectory = resolve("dist", "bundle", "macos-arm64");
  const configuration = createMacosArtifactConfiguration({
    version: "0.1.0",
    bundleDirectory,
    outputDirectory: resolve("dist", "artifacts"),
  });
  assert.equal(
    configuration.mac && !Array.isArray(configuration.mac) && configuration.mac.identity,
    null,
  );
  assert.equal(
    configuration.mac && !Array.isArray(configuration.mac) && configuration.mac.artifactName,
    "Cinba-0.1.0-macos-arm64.${ext}",
  );
  assert.deepEqual(configuration.extraResources, [{ from: bundleDirectory, to: "cinba-bundle" }]);
  assert.equal(configuration.electronDist, undefined);
  assert.deepEqual(configuration.dmg?.contents, [{ x: 220, y: 200, type: "file" }]);
});

test("the macOS artifact configuration rejects mutable versions and relative inputs", () => {
  assert.throws(
    () =>
      createMacosArtifactConfiguration({
        version: "0.1.0-beta.1",
        bundleDirectory: resolve("bundle"),
        outputDirectory: resolve("artifacts"),
      }),
    /stable SemVer/,
  );
  assert.throws(
    () =>
      createMacosArtifactConfiguration({
        version: "0.1.0",
        bundleDirectory: "bundle",
        outputDirectory: resolve("artifacts"),
      }),
    /must be absolute/,
  );
});
