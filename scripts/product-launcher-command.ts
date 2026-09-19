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
      type: "begin-update-handoff";
      surface: "desktop";
      blockingProcessId: number;
      expectedVersion: string;
    }
  | {
      type: "begin-update-handoff";
      surface: "tui";
      blockingProcessId: number;
      expectedVersion: string;
      workingDirectory: string;
    }
  | {
      type: "update-handoff-helper";
      parentProcessId: number;
    }
  | { type: "check-update-readiness"; expectedVersion: string }
  | { type: "uninstall"; purge: boolean; deleteAllCinbaData: boolean }
  | {
      type: "uninstall-helper";
      parentProcessId: number;
      purge: boolean;
      blockingProcessId?: number;
    }
  | {
      type: "begin-uninstall";
      surface: "desktop" | "tui";
      blockingProcessId: number;
      purge: boolean;
    }
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
    (arguments_.length === 3 || arguments_.length === 4) &&
    arguments_[0] === "__uninstall-helper" &&
    /^[1-9]\d*$/.test(arguments_[1]!) &&
    (arguments_[2] === "normal" || arguments_[2] === "purge") &&
    (arguments_.length === 3 || /^[1-9]\d*$/.test(arguments_[3]!))
  ) {
    const parentProcessId = Number(arguments_[1]);
    if (!Number.isSafeInteger(parentProcessId)) {
      throw new Error("uninstall helper parent process id is invalid");
    }
    return {
      type: "uninstall-helper",
      parentProcessId,
      purge: arguments_[2] === "purge",
      ...(arguments_.length === 4
        ? { blockingProcessId: parsePositiveProcessId(arguments_[3]!) }
        : {}),
    };
  }
  if (
    arguments_.length === 4 &&
    arguments_[0] === "__begin-uninstall" &&
    (arguments_[1] === "desktop" || arguments_[1] === "tui") &&
    (arguments_[3] === "normal" || arguments_[3] === "purge")
  ) {
    return {
      type: "begin-uninstall",
      surface: arguments_[1],
      blockingProcessId: parsePositiveProcessId(arguments_[2]!),
      purge: arguments_[3] === "purge",
    };
  }
  if (arguments_[0] === "__begin-uninstall") {
    throw new Error("invalid foreground uninstall command");
  }
  if (
    arguments_.length === 4 &&
    arguments_[0] === "__begin-update-handoff" &&
    arguments_[1] === "desktop"
  ) {
    const blockingProcessId = parsePositiveProcessId(arguments_[2]!);
    return {
      type: "begin-update-handoff",
      surface: "desktop",
      blockingProcessId,
      expectedVersion: parseExpectedVersion(arguments_[3]!),
    };
  }
  if (
    arguments_.length === 5 &&
    arguments_[0] === "__begin-update-handoff" &&
    arguments_[1] === "tui" &&
    isAbsolute(arguments_[4]!)
  ) {
    return {
      type: "begin-update-handoff",
      surface: "tui",
      blockingProcessId: parsePositiveProcessId(arguments_[2]!),
      expectedVersion: parseExpectedVersion(arguments_[3]!),
      workingDirectory: arguments_[4]!,
    };
  }
  if (arguments_[0] === "__begin-update-handoff") {
    throw new Error("invalid foreground update handoff command");
  }
  if (arguments_.length === 2 && arguments_[0] === "__update-handoff-helper") {
    return {
      type: "update-handoff-helper",
      parentProcessId: parsePositiveProcessId(arguments_[1]!),
    };
  }
  if (arguments_[0] === "__update-handoff-helper") {
    throw new Error("invalid update handoff helper command");
  }
  if (
    arguments_.length === 2 &&
    arguments_[0] === "__check-update-readiness" &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(arguments_[1]!)
  ) {
    return {
      type: "check-update-readiness",
      expectedVersion: arguments_[1]!,
    };
  }
  if (arguments_[0] === "__check-update-readiness") {
    throw new Error("invalid update readiness command");
  }
  return { type: "product", arguments: arguments_ };
}

function parseExpectedVersion(value: string): string {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error("foreground update handoff expected version is invalid");
  }
  return value;
}

export function parsePositiveProcessId(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("process id must be a positive integer");
  }
  const processId = Number(value);
  if (!Number.isSafeInteger(processId)) {
    throw new Error("process id must be a positive integer");
  }
  return processId;
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
