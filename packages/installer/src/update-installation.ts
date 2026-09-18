import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, win32 } from "node:path";
import type { ProductTarget } from "./platform.ts";
import { type VerifiedReleaseBundle, verifyReleaseBundle } from "./release-bundle.ts";

export type UpdateInstallerResult = { exitCode: number; stdout: string; stderr: string };
export type UpdateInstallerProcessOptions = { environment?: NodeJS.ProcessEnv };
export type RunUpdateInstaller = (
  executable: string,
  arguments_: readonly string[],
  options?: UpdateInstallerProcessOptions,
) => Promise<UpdateInstallerResult>;
export type VerifyUpdateArtifact = (path: string, expectedSha256: string) => Promise<void>;

async function verifyUpdateArtifact(path: string, expectedSha256: string): Promise<void> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  if (hash.digest("hex") !== expectedSha256) {
    throw new Error("prepared update artifact SHA-256 does not match");
  }
}

function defaultRun(
  executable: string,
  arguments_: readonly string[],
  options?: UpdateInstallerProcessOptions,
): Promise<UpdateInstallerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      env: options?.environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

async function checked(
  run: RunUpdateInstaller,
  executable: string,
  arguments_: readonly string[],
  options?: UpdateInstallerProcessOptions,
): Promise<UpdateInstallerResult> {
  const result = await run(executable, arguments_, options);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim().slice(0, 2_048);
    throw new Error(
      `${executable} exited with code ${result.exitCode}${stderr ? `: ${stderr}` : ""}`,
    );
  }
  return result;
}

function validateTarEntries(output: string): void {
  for (const entry of output.split(/\r?\n/).filter(Boolean)) {
    const path = entry.replace(/\/+$/, "").replace(/^\.\/+/, "");
    if (
      path.startsWith("/") ||
      path.startsWith("\\") ||
      /^[A-Za-z]:/.test(path) ||
      path.split(/[\\/]/).includes("..")
    ) {
      throw new Error(`update archive contains an unsafe path: ${entry}`);
    }
  }
}

function expectedInstallEnvironment(options: {
  version: string;
  revision: string;
  target: ProductTarget;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CINBA_EXPECTED_VERSION: options.version,
    CINBA_EXPECTED_REVISION: options.revision,
    CINBA_EXPECTED_TARGET: options.target,
  };
}

async function verifyExpectedBundle(options: {
  bundleDirectory: string;
  target: ProductTarget;
  version: string;
  revision: string;
  verify: typeof verifyReleaseBundle;
}): Promise<VerifiedReleaseBundle> {
  const bundle = await options.verify(options.bundleDirectory, options.target);
  if (
    bundle.metadata.version !== options.version ||
    bundle.metadata.revision !== options.revision ||
    bundle.metadata.target !== options.target
  ) {
    throw new Error("release bundle identity does not match the prepared update");
  }
  return bundle;
}

async function runMacosInstallation(
  run: RunUpdateInstaller,
  artifactPath: string,
  mountPoint: string,
  expected: { version: string; revision: string; target: "macos-arm64" },
  verify: typeof verifyReleaseBundle,
): Promise<void> {
  await checked(run, "hdiutil", [
    "attach",
    "-nobrowse",
    "-readonly",
    "-mountpoint",
    mountPoint,
    artifactPath,
  ]);
  let failure: unknown;
  try {
    const bundle = await verifyExpectedBundle({
      bundleDirectory: posix.join(mountPoint, "Cinba.app", "Contents", "Resources", "cinba-bundle"),
      ...expected,
      verify,
    });
    await checked(run, bundle.launcher, ["install"], {
      environment: expectedInstallEnvironment(expected),
    });
  } catch (error) {
    failure = error;
  }
  try {
    await checked(run, "hdiutil", ["detach", mountPoint]);
  } catch (error) {
    failure ??= error;
  }
  if (failure) {
    throw failure;
  }
}

export async function installPreparedUpdateArtifact(options: {
  target: ProductTarget;
  artifactPath: string;
  expectedVersion: string;
  expectedRevision: string;
  expectedSha256: string;
  run?: RunUpdateInstaller;
  verifyArtifact?: VerifyUpdateArtifact;
  verifyBundle?: typeof verifyReleaseBundle;
  makeTemporaryDirectory?: () => Promise<string>;
  removeTemporaryDirectory?: (path: string) => Promise<void>;
}): Promise<void> {
  if (!isAbsolute(options.artifactPath) && !win32.isAbsolute(options.artifactPath)) {
    throw new Error("prepared update artifact path must be absolute");
  }
  if (!/^[0-9a-f]{64}$/.test(options.expectedSha256)) {
    throw new Error("prepared update artifact SHA-256 is invalid");
  }
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(options.expectedVersion) ||
    !/^[0-9a-f]{40}$/.test(options.expectedRevision)
  ) {
    throw new Error("prepared update release identity is invalid");
  }
  await (options.verifyArtifact ?? verifyUpdateArtifact)(
    options.artifactPath,
    options.expectedSha256,
  );
  const run = options.run ?? defaultRun;
  const expected = {
    version: options.expectedVersion,
    revision: options.expectedRevision,
    target: options.target,
  };
  if (options.target === "windows-x64") {
    await checked(run, options.artifactPath, ["/S"], {
      environment: expectedInstallEnvironment(expected),
    });
    return;
  }

  const temporary = await (
    options.makeTemporaryDirectory ?? (() => mkdtemp(join(tmpdir(), "cinba-update-")))
  )();
  const remove =
    options.removeTemporaryDirectory ??
    ((path: string) => rm(path, { recursive: true, force: true }));
  let failure: unknown;
  try {
    if (options.target === "linux-x64-gnu") {
      const listed = await checked(run, "tar", ["-tzf", options.artifactPath]);
      validateTarEntries(listed.stdout);
      const bundle = posix.join(temporary, "bundle");
      await mkdir(bundle, { recursive: true });
      await checked(run, "tar", [
        "-xzf",
        options.artifactPath,
        "-C",
        bundle,
        "--no-same-owner",
        "--no-same-permissions",
      ]);
      const verified = await verifyExpectedBundle({
        bundleDirectory: bundle,
        ...expected,
        verify: options.verifyBundle ?? verifyReleaseBundle,
      });
      await checked(run, verified.launcher, ["install"], {
        environment: expectedInstallEnvironment(expected),
      });
    } else {
      const mountPoint = posix.join(temporary, "mount");
      await mkdir(mountPoint, { recursive: true });
      await runMacosInstallation(
        run,
        options.artifactPath,
        mountPoint,
        { ...expected, target: "macos-arm64" },
        options.verifyBundle ?? verifyReleaseBundle,
      );
    }
  } catch (error) {
    failure = error;
  }
  try {
    await remove(temporary);
  } catch (error) {
    failure ??= error;
  }
  if (failure) {
    throw failure;
  }
}
