import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

test("the current release pointer is strict, atomic, and removable", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-install-store-"));
  const paths = layout(root);
  const release = {
    version: "1.2.3",
    revision: REVISION,
    protocolVersion: 1,
    dataFormatVersion: 1,
    target: "windows-x64" as const,
    directory: REVISION,
  };
  try {
    await writeCurrentRelease(paths, release);
    assert.deepEqual(await readCurrentRelease(paths), release);
    assert.match(
      await readFile(join(paths.programDirectory, "current.json"), "utf8"),
      /"schemaVersion": 1/,
    );
    await clearCurrentRelease(paths);
    assert.equal(await readCurrentRelease(paths), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
