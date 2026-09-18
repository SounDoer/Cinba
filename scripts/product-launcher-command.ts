import { dirname, isAbsolute, resolve } from "node:path";

type ExpectedProductInstallRelease = {
  version: string;
  revision: string;
  target: "windows-x64" | "macos-arm64" | "linux-x64-gnu";
};

export type StableLauncherCommand =
  | { type: "install"; bundleDirectory: string }
  | { type: "update" }
  | {
      type: "update-helper";
      parentProcessId: number;
      leaseToken: string;
      artifactPath: string;
      version: string;
      revision: string;
      sha256: string;
    }
  | { type: "uninstall"; purge: boolean; deleteAllCinbaData: boolean }
  | { type: "uninstall-helper"; parentProcessId: number; purge: boolean }
  | { type: "product"; arguments: string[] };

export function parseStableLauncherCommand(
  arguments_: string[],
  executable: string,
): StableLauncherCommand {
  if (arguments_.length === 1 && arguments_[0] === "install") {
    return { type: "install", bundleDirectory: resolve(dirname(executable), "..") };
  }
  if (arguments_.length === 1 && arguments_[0] === "update") {
    return { type: "update" };
  }
  if (arguments_.length === 1 && arguments_[0] === "uninstall") {
    return { type: "uninstall", purge: false, deleteAllCinbaData: false };
  }
  if (
    arguments_[0] === "uninstall" &&
    (arguments_.length === 2 || arguments_.length === 3) &&
    arguments_[1] === "--purge" &&
    (arguments_.length === 2 || arguments_[2] === "--delete-all-cinba-data")
  ) {
    return {
      type: "uninstall",
      purge: true,
      deleteAllCinbaData: arguments_.length === 3,
    };
  }
  if (
    arguments_.length === 3 &&
    arguments_[0] === "__uninstall-helper" &&
    /^[1-9]\d*$/.test(arguments_[1]!) &&
    (arguments_[2] === "normal" || arguments_[2] === "purge")
  ) {
    const parentProcessId = Number(arguments_[1]);
    if (!Number.isSafeInteger(parentProcessId)) {
      throw new Error("uninstall helper parent process id is invalid");
    }
    return { type: "uninstall-helper", parentProcessId, purge: arguments_[2] === "purge" };
  }
  if (
    arguments_.length === 7 &&
    arguments_[0] === "__update-helper" &&
    /^[1-9]\d*$/.test(arguments_[1]!) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      arguments_[2]!,
    ) &&
    isAbsolute(arguments_[3]!) &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(arguments_[4]!) &&
    /^[0-9a-f]{40}$/.test(arguments_[5]!) &&
    /^[0-9a-f]{64}$/.test(arguments_[6]!)
  ) {
    const parentProcessId = Number(arguments_[1]);
    if (!Number.isSafeInteger(parentProcessId)) {
      throw new Error("update helper parent process id is invalid");
    }
    return {
      type: "update-helper",
      parentProcessId,
      leaseToken: arguments_[2]!,
      artifactPath: arguments_[3]!,
      version: arguments_[4]!,
      revision: arguments_[5]!,
      sha256: arguments_[6]!,
    };
  }
  return { type: "product", arguments: arguments_ };
}

export function parseExpectedProductInstallRelease(
  environment: NodeJS.ProcessEnv,
): ExpectedProductInstallRelease | undefined {
  const version = environment.CINBA_EXPECTED_VERSION;
  const revision = environment.CINBA_EXPECTED_REVISION;
  const target = environment.CINBA_EXPECTED_TARGET;
  if (version === undefined && revision === undefined && target === undefined) {
    return undefined;
  }
  if (
    !version ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
    !revision ||
    !/^[0-9a-f]{40}$/.test(revision) ||
    (target !== "windows-x64" && target !== "macos-arm64" && target !== "linux-x64-gnu")
  ) {
    throw new Error("expected product install release identity is invalid");
  }
  return { version, revision, target };
}
