import { execFile } from "node:child_process";
import { release } from "node:os";
import type { ReleaseArtifact } from "./manifest.ts";
import { type ProductTarget, compareDottedVersions } from "./platform.ts";

export type DetectedSystem =
  | { platform: "windows"; version: string }
  | { platform: "macos"; version: string }
  | { platform: "linux-gnu"; kernel: string; glibc: string };

type RunFile = (file: string, arguments_: readonly string[]) => Promise<string>;

function runFile(file: string, arguments_: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...arguments_], { encoding: "utf8", windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

function requiredVersion(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new Error(`${context} is unavailable`);
  }
  const version = /^(\d+(?:\.\d+)*)/.exec(value.trim())?.[1];
  if (!version) {
    throw new Error(`${context} is invalid`);
  }
  return version;
}

export async function detectCurrentSystem(
  target: ProductTarget,
  options: {
    platform?: NodeJS.Platform;
    kernelRelease?: () => string;
    runFile?: RunFile;
    report?: () => unknown;
  } = {},
): Promise<DetectedSystem> {
  const platform = options.platform ?? process.platform;
  let expected: NodeJS.Platform = "linux";
  if (target === "windows-x64") {
    expected = "win32";
  } else if (target === "macos-arm64") {
    expected = "darwin";
  }
  if (platform !== expected) {
    throw new Error(`runtime platform ${platform} does not match ${target}`);
  }
  if (target === "windows-x64") {
    return {
      platform: "windows",
      version: requiredVersion((options.kernelRelease ?? release)(), "Windows kernel version"),
    };
  }
  if (target === "macos-arm64") {
    const version = await (options.runFile ?? runFile)("/usr/bin/sw_vers", ["-productVersion"]);
    return { platform: "macos", version: requiredVersion(version, "macOS version") };
  }
  const report = (
    options.report ??
    (() => {
      if (!process.report?.getReport) {
        throw new Error("Node.js runtime report is unavailable");
      }
      return process.report.getReport();
    })
  )() as { header?: { glibcVersionRuntime?: unknown } };
  return {
    platform: "linux-gnu",
    kernel: requiredVersion((options.kernelRelease ?? release)(), "Linux kernel version"),
    glibc: requiredVersion(report.header?.glibcVersionRuntime, "runtime glibc version"),
  };
}

export function systemMeetsArtifactMinimum(
  artifact: ReleaseArtifact,
  system: DetectedSystem,
): boolean {
  if (artifact.target === "windows-x64") {
    return (
      system.platform === "windows" &&
      compareDottedVersions(system.version, artifact.minimumSystem.version) >= 0
    );
  }
  if (artifact.target === "macos-arm64") {
    return (
      system.platform === "macos" &&
      compareDottedVersions(system.version, artifact.minimumSystem.version) >= 0
    );
  }
  return (
    system.platform === "linux-gnu" &&
    compareDottedVersions(system.kernel, artifact.minimumSystem.kernel) >= 0 &&
    compareDottedVersions(system.glibc, artifact.minimumSystem.glibc) >= 0
  );
}
