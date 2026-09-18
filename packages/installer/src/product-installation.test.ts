import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { ProductPaths } from "./paths.ts";
import { stableFileInstallMode, verifyInstalledProductRelease } from "./product-installation.ts";

const revision = "a".repeat(40);

test("the installed release probe uses the private runtime and exact product identity", async () => {
  const releaseDirectory = join(process.cwd(), "release");
  let invocation: { executable: string; arguments: string[]; workingDirectory: string } | undefined;
  await verifyInstalledProductRelease({
    releaseDirectory,
    target: "windows-x64",
    version: "1.2.3",
    revision,
    run: async (executable, arguments_, options) => {
      invocation = {
        executable,
        arguments: arguments_,
        workingDirectory: options.workingDirectory,
      };
      return { exitCode: 0, stdout: `Cinba 1.2.3 (${revision})\n`, stderr: "" };
    },
  });
  assert.deepEqual(invocation, {
    executable: join(releaseDirectory, "runtime", "node.exe"),
    arguments: [join(releaseDirectory, "lib", "cli.mjs"), "--version"],
    workingDirectory: releaseDirectory,
  });
});

test("the installed release probe rejects output from a different payload", async () => {
  await assert.rejects(
    verifyInstalledProductRelease({
      releaseDirectory: join(process.cwd(), "release"),
      target: "linux-x64-gnu",
      version: "1.2.3",
      revision,
      run: async () => ({
        exitCode: 0,
        stdout: `Cinba 1.2.4 (${revision})\n`,
        stderr: "",
      }),
    }),
    /identity probe failed/,
  );
});

test("a first macOS install can replace the installer app that contains its bundle", () => {
  const desktopApplicationPath = join(process.cwd(), "Applications", "Cinba.app");
  const paths = {
    desktopApplicationPath,
  } as ProductPaths;
  assert.equal(
    stableFileInstallMode({
      bundleDirectory: join(desktopApplicationPath, "Contents", "Resources", "cinba-bundle"),
      paths,
      target: "macos-arm64",
      hasCurrentRelease: false,
    }),
    "replace",
  );
  assert.equal(
    stableFileInstallMode({
      bundleDirectory: join(process.cwd(), "Volumes", "Cinba", "cinba-bundle"),
      paths,
      target: "macos-arm64",
      hasCurrentRelease: false,
    }),
    "create",
  );
});
