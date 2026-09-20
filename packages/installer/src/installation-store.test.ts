import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import {
  type InstallationLayout,
  clearCurrentRelease,
  parseCurrentReleasePointer,
  readCurrentRelease,
  writeCurrentRelease,
} from "./installation-store.ts";

const REVISION = "abcdef1234567890abcdef1234567890abcdef12";

function layout(root: string): InstallationLayout {
  return {
    programDirectory: join(root, "program"),
    releasesDirectory: join(root, "program", "releases"),
    transactionDirectory: join(root, "state", "install"),
  };
}

test("the current release pointer is strict, atomic, and removable", async (t) => {
  const root = temporaryDirectory("cinba-install-store-", t);
  const paths = layout(root);
  const release = {
    version: "1.2.3",
    revision: REVISION,
    protocolVersion: 1,
    dataFormatVersion: 1,
    target: "windows-x64" as const,
    directory: REVISION,
  };
  await writeCurrentRelease(paths, release);
  assert.deepEqual(await readCurrentRelease(paths), release);
  assert.match(
    await readFile(join(paths.programDirectory, "current.json"), "utf8"),
    /"schemaVersion": 1/,
  );
  await clearCurrentRelease(paths);
  assert.equal(await readCurrentRelease(paths), undefined);
});

test("a current pointer cannot escape the releases directory", () => {
  assert.throws(
    () =>
      parseCurrentReleasePointer({
        schemaVersion: 1,
        release: {
          version: "1.2.3",
          revision: REVISION,
          protocolVersion: 1,
          dataFormatVersion: 1,
          target: "windows-x64",
          directory: "../outside",
        },
      }),
    { message: "installed release directory is not a safe direct child" },
  );
});

test("product path metadata is not mistaken for an installation path", async (t) => {
  const root = temporaryDirectory("cinba-install-product-paths-", t);
  const paths = {
    ...layout(root),
    identity: "release",
    applicationId: "com.soundoer.cinba",
  };
  assert.equal(await readCurrentRelease(paths), undefined);
});

test("a separate stable manager directory can own the current pointer", async (t) => {
  const root = temporaryDirectory("cinba-install-pointer-directory-", t);
  const paths = {
    ...layout(root),
    currentPointerDirectory: join(root, "manager"),
  };
  const release = {
    version: "1.2.3",
    revision: REVISION,
    protocolVersion: 1,
    dataFormatVersion: 1,
    target: "macos-arm64" as const,
    directory: REVISION,
  };
  await writeCurrentRelease(paths, release);
  assert.deepEqual(await readCurrentRelease(paths), release);
  assert.match(
    await readFile(join(paths.currentPointerDirectory, "current.json"), "utf8"),
    /"schemaVersion": 1/,
  );
});

test("macOS release storage can live outside the application bundle", async (t) => {
  const root = temporaryDirectory("cinba-install-macos-layout-", t);
  const paths = {
    programDirectory: join(root, "Applications", "Cinba.app"),
    releasesDirectory: join(
      root,
      "Library",
      "Application Support",
      "com.soundoer.cinba",
      "Releases",
    ),
    transactionDirectory: join(
      root,
      "Library",
      "Application Support",
      "com.soundoer.cinba",
      "Installer",
    ),
    currentPointerDirectory: join(
      root,
      "Library",
      "Application Support",
      "com.soundoer.cinba",
      "Installer",
    ),
  } satisfies InstallationLayout;
  const release = {
    version: "1.2.3",
    revision: REVISION,
    protocolVersion: 1,
    dataFormatVersion: 1,
    target: "macos-arm64" as const,
    directory: REVISION,
  };
  await writeCurrentRelease(paths, release);
  assert.deepEqual(await readCurrentRelease(paths), release);
});
