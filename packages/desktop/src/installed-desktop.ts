import { homedir } from "node:os";
import { join } from "node:path";
import {
  type InstalledRelease,
  type ProductPaths,
  type ProductTarget,
  readCurrentRelease,
  requireProductTarget,
  resolveProductPaths,
} from "@cinba/installer";

export function installedDesktopEntry(
  paths: ProductPaths,
  current: InstalledRelease | undefined,
  target: ProductTarget,
): { payloadRoot: string; entry: string } {
  if (target === "linux-x64-gnu") {
    throw new Error("Cinba Desktop is not available on Linux");
  }
  if (!current) {
    throw new Error("Cinba has no active installed release");
  }
  if (current.target !== target) {
    throw new Error(`installed ${current.target} release cannot run on ${target}`);
  }
  const payloadRoot = join(paths.releasesDirectory, current.directory);
  return { payloadRoot, entry: join(payloadRoot, "lib", "desktop.mjs") };
}

export async function resolveInstalledDesktopEntry(
  options: {
    homeDirectory?: string;
    environment?: NodeJS.ProcessEnv;
    platform?: "win32" | "darwin";
  } = {},
): Promise<{ payloadRoot: string; entry: string }> {
  const target = requireProductTarget();
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && platform !== "darwin") {
    throw new Error(`Cinba Desktop is not available on ${platform}`);
  }
  const paths = resolveProductPaths({
    platform,
    homeDirectory: options.homeDirectory ?? homedir(),
    environment: options.environment ?? process.env,
  });
  return installedDesktopEntry(paths, await readCurrentRelease(paths), target);
}
