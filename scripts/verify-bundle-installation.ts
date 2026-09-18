import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  installProductBundle,
  requireProductTarget,
  resolveInstalledProductCommand,
  resolveProductPaths,
  runInstalledProductCommand,
} from "@cinba/installer";

export async function verifyBundleInstallation(bundleDirectory: string): Promise<void> {
  const target = requireProductTarget();
  const platform = process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`Cinba is not available on ${platform}`);
  }
  const root = await mkdtemp(join(tmpdir(), "cinba-bundle-installation-"));
  const paths = resolveProductPaths({
    platform,
    homeDirectory: root,
    environment:
      platform === "win32"
        ? { LOCALAPPDATA: join(root, "LocalAppData") }
        : {
            XDG_DATA_HOME: join(root, "data"),
            XDG_STATE_HOME: join(root, "state"),
            XDG_CACHE_HOME: join(root, "cache"),
            XDG_CONFIG_HOME: join(root, "config"),
          },
  });
  try {
    const transaction = await installProductBundle({ bundleDirectory, paths, target });
    const command = await resolveInstalledProductCommand({
      layout: paths,
      target,
      arguments: ["--version"],
    });
    const exitCode = await runInstalledProductCommand(command, { workingDirectory: root });
    if (exitCode !== 0) {
      throw new Error("installed stable launcher command probe failed");
    }
    console.log(
      `[bundle] Installed and launched Cinba ${transaction.candidate.version} in an isolated home`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const bundleDirectory = process.argv[2];
  if (!bundleDirectory) {
    throw new Error("usage: verify-bundle-installation <bundle-directory>");
  }
  await verifyBundleInstallation(resolve(bundleDirectory));
}
