import { dirname, resolve } from "node:path";

export type StableLauncherCommand =
  { type: "install"; bundleDirectory: string } | { type: "product"; arguments: string[] };

export function parseStableLauncherCommand(
  arguments_: string[],
  executable: string,
): StableLauncherCommand {
  if (arguments_.length === 1 && arguments_[0] === "install") {
    return { type: "install", bundleDirectory: resolve(dirname(executable), "..") };
  }
  return { type: "product", arguments: arguments_ };
}
