import { dirname, resolve } from "node:path";

export type StableLauncherCommand =
  | { type: "install"; bundleDirectory: string }
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
  return { type: "product", arguments: arguments_ };
}
