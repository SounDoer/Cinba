import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import type { InstalledRelease, ProductPaths } from "@cinba/installer";
import { installedDesktopEntry } from "./installed-desktop.ts";

const root = resolve("installed-cinba");
const paths = {
  releasesDirectory: join(root, "releases"),
} as ProductPaths;
const current: InstalledRelease = {
  version: "0.1.0",
  revision: "a".repeat(40),
  protocolVersion: 1,
  dataFormatVersion: 1,
  target: "windows-x64",
  directory: "a".repeat(40),
};

test("the Desktop shell resolves main from the current versioned payload", () => {
  const payloadRoot = join(paths.releasesDirectory, current.directory);
  assert.deepEqual(installedDesktopEntry(paths, current, "windows-x64"), {
    payloadRoot,
    entry: join(payloadRoot, "lib", "desktop.mjs"),
  });
});

test("the Desktop shell rejects a missing, mismatched, or Linux release", () => {
  assert.throws(() => installedDesktopEntry(paths, undefined, "windows-x64"), {
    message: "Cinba has no active installed release",
  });
  assert.throws(() => installedDesktopEntry(paths, current, "macos-arm64"), {
    message: "installed windows-x64 release cannot run on macos-arm64",
  });
  assert.throws(() => installedDesktopEntry(paths, current, "linux-x64-gnu"), {
    message: "Cinba Desktop is not available on Linux",
  });
});
