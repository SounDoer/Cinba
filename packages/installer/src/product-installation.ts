import { spawn } from "node:child_process";
import { join } from "node:path";
import { installReleaseBundle } from "./bundle-installation.ts";
import { type InstallationTransaction, readCurrentRelease } from "./installation-store.ts";
import type { ProductPaths } from "./paths.ts";
import type { ProductTarget } from "./platform.ts";
import { prepareStableProductFiles } from "./stable-files.ts";

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

export async function installProductBundle(options: {
  bundleDirectory: string;
  paths: ProductPaths;
  target: ProductTarget;
  transactionId?: string;
  verify?: typeof verifyInstalledProductRelease;
}): Promise<InstallationTransaction> {
  const mode = (await readCurrentRelease(options.paths)) ? "replace" : "create";
  return await installReleaseBundle({
    bundleDirectory: options.bundleDirectory,
    layout: options.paths,
    expectedTarget: options.target,
    ...(options.transactionId ? { transactionId: options.transactionId } : {}),
    prepareStableFiles: async (bundle) =>
      await prepareStableProductFiles({ bundle, paths: options.paths, mode }),
    verify: async (releaseDirectory, release) =>
      await (options.verify ?? verifyInstalledProductRelease)({
        releaseDirectory,
        target: release.target,
        version: release.version,
        revision: release.revision,
      }),
  });
}
