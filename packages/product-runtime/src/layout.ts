import { isAbsolute, join, resolve } from "node:path";

export type ProductPayloadLayout = {
  root: string;
  cliEntry: string;
  coreEntry: string;
  syncEntry: string;
  tuiEntry: string;
  extensionRoot: string;
  webRoot: string;
  syncWebRoot: string;
  nodeExecutable: string;
  releaseFile: string;
  inventoryFile: string;
};

export function resolveProductPayloadLayout(
  rootDirectory: string,
  platform: NodeJS.Platform = process.platform,
): ProductPayloadLayout {
  if (!isAbsolute(rootDirectory)) {
    throw new Error("product payload root must be an absolute path");
  }
  const root = resolve(rootDirectory);
  return {
    root,
    cliEntry: join(root, "lib", "cli.mjs"),
    coreEntry: join(root, "lib", "core.mjs"),
    syncEntry: join(root, "lib", "sync.mjs"),
    tuiEntry: join(root, "lib", "tui.mjs"),
    extensionRoot: join(root, "extensions"),
    webRoot: join(root, "web"),
    syncWebRoot: join(root, "sync-web"),
    nodeExecutable:
      platform === "win32"
        ? join(root, "runtime", "node.exe")
        : join(root, "runtime", "bin", "node"),
    releaseFile: join(root, "release.json"),
    inventoryFile: join(root, "inventory.json"),
  };
}
