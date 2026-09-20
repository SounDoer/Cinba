import { spawn } from "node:child_process";
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { type ReleaseBundleProgress, installReleaseBundle } from "./bundle-installation.ts";
import { waitForInstallationIdle } from "./installation-lock.ts";
import { type InstallationTransaction, readCurrentRelease } from "./installation-store.ts";
import type { ProductPaths } from "./paths.ts";
import type { ProductTarget } from "./platform.ts";
import { prepareStableProductFiles } from "./stable-files.ts";

function isInside(parent: string, child: string): boolean {
  const path = relative(resolvePath(parent), resolvePath(child));
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function stableFileInstallMode(options: {
  bundleDirectory: string;
  paths: ProductPaths;
  target: ProductTarget;
  hasCurrentRelease: boolean;
}): "create" | "replace" {
  if (options.hasCurrentRelease) {
    return "replace";
  }
  if (
    options.target === "macos-arm64" &&
    options.paths.desktopApplicationPath &&
    isInside(options.paths.desktopApplicationPath, options.bundleDirectory)
  ) {
    return "replace";
  }
  return "create";
}

function childOutput(
  executable: string,
  arguments_: string[],
  options: { workingDirectory: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: options.workingDirectory,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`installed release probe stopped by ${signal}`));
      } else {
        resolve({ exitCode: code ?? 0, stdout, stderr });
      }
    });
  });
}

export async function verifyInstalledProductRelease(options: {
  releaseDirectory: string;
  target: ProductTarget;
  version: string;
  revision: string;
  run?: typeof childOutput;
}): Promise<void> {
  const executable =
    options.target === "windows-x64"
      ? join(options.releaseDirectory, "runtime", "node.exe")
      : join(options.releaseDirectory, "runtime", "bin", "node");
  const entry = join(options.releaseDirectory, "lib", "cli.mjs");
  const result = await (options.run ?? childOutput)(executable, [entry, "--version"], {
    workingDirectory: options.releaseDirectory,
  });
  const expected = `Cinba ${options.version} (${options.revision})`;
  if (result.exitCode !== 0 || result.stdout.trim() !== expected || result.stderr.trim() !== "") {
    throw new Error("installed release CLI identity probe failed");
  }
}

export type ProductInstallationProgress =
  ReleaseBundleProgress | "waiting-for-lock" | "lock-released" | "verifying";

export async function installProductBundle(options: {
  bundleDirectory: string;
  paths: ProductPaths;
  target: ProductTarget;
  expectedRelease?: {
    version: string;
    revision: string;
    target: ProductTarget;
  };
  transactionId?: string;
  consumeBundle?: boolean;
  verify?: typeof verifyInstalledProductRelease;
  report?: (progress: ProductInstallationProgress) => void;
}): Promise<InstallationTransaction> {
  const report = options.report;
  // A detached uninstall helper keeps the installation lock until it has removed the program.
  await waitForInstallationIdle(options.paths, {
    onWait: (state) => report?.(state === "waiting" ? "waiting-for-lock" : "lock-released"),
  });
  const mode = stableFileInstallMode({
    bundleDirectory: options.bundleDirectory,
    paths: options.paths,
    target: options.target,
    hasCurrentRelease: Boolean(await readCurrentRelease(options.paths)),
  });
  return await installReleaseBundle({
    bundleDirectory: options.bundleDirectory,
    layout: options.paths,
    expectedTarget: options.target,
    ...(options.expectedRelease ? { expectedRelease: options.expectedRelease } : {}),
    ...(options.transactionId ? { transactionId: options.transactionId } : {}),
    ...(options.consumeBundle ? { consumeBundle: true } : {}),
    ...(report ? { report } : {}),
    prepareStableFiles: async (bundle) =>
      await prepareStableProductFiles({ bundle, paths: options.paths, mode }),
    verify: async (releaseDirectory, release) => {
      report?.("verifying");
      await (options.verify ?? verifyInstalledProductRelease)({
        releaseDirectory,
        target: release.target,
        version: release.version,
        revision: release.revision,
      });
    },
  });
}
