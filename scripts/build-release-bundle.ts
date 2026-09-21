import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createArtifactInventory,
  parsePayloadRelease,
  requireProductTarget,
  verifyReleaseBundle,
} from "@cinba/installer";
import { buildDesktopApplication } from "./build-desktop-app.ts";
import { buildProductLauncher } from "./build-product-launcher.ts";
import { buildProductPayload } from "./build-product-payload.ts";
import { verifyBundleInstallation } from "./verify-bundle-installation.ts";
import { verifyMacosApplicationSignature } from "./verify-macos-application.ts";
import { renderBundledLinuxInstaller } from "./linux-install-scripts.ts";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export async function buildReleaseBundle(): Promise<string> {
  const target = requireProductTarget();
  const root = join(REPOSITORY_ROOT, "dist", "bundle", target);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  const payloadSource = await buildProductPayload();
  const payload = parsePayloadRelease(
    JSON.parse(await readFile(join(payloadSource, "release.json"), "utf8")) as unknown,
  );
  await cp(payloadSource, join(root, "payload"), { recursive: true });
  const launcher = await buildProductLauncher();
  await mkdir(join(root, "launcher"), { recursive: true });
  await cp(launcher, join(root, "launcher", target === "windows-x64" ? "cinba.exe" : "cinba"));

  if (target !== "linux-x64-gnu") {
    const [desktopSource] = await buildDesktopApplication();
    if (!desktopSource) {
      throw new Error("Desktop build did not return an application directory");
    }
    const desktopDestination =
      target === "macos-arm64" ? join(root, "desktop", "Cinba.app") : join(root, "desktop");
    await mkdir(dirname(desktopDestination), { recursive: true });
    // Electron frameworks use versioned symlinks. Dereferencing them duplicates the target trees,
    // makes the framework layout ambiguous to codesign, and leaves the installed Desktop invalid.
    await cp(desktopSource, desktopDestination, {
      recursive: true,
      dereference: target !== "macos-arm64",
      verbatimSymlinks: target === "macos-arm64",
    });
    if (target === "macos-arm64") {
      await verifyMacosApplicationSignature(desktopDestination);
    }
  } else {
    const installer = join(root, "install.sh");
    await writeFile(installer, renderBundledLinuxInstaller(), { mode: 0o755 });
    await chmod(installer, 0o755);
  }

  const identity = { version: payload.version, revision: payload.revision, target };
  await writeFile(
    join(root, "bundle.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        product: "Cinba",
        ...identity,
        kind: target === "linux-x64-gnu" ? "headless" : "desktop",
      },
      null,
      2,
    )}\n`,
  );
  const inventory = await createArtifactInventory(root, identity, {
    inventoryFileName: "bundle-inventory.json",
  });
  await writeFile(join(root, "bundle-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
  await verifyReleaseBundle(root, target);
  await verifyBundleInstallation(root);
  return root;
}

if (import.meta.main) {
  buildReleaseBundle()
    .then((output) => console.log(`[bundle] Built and verified ${output}`))
    .catch((error: unknown) => {
      console.error(`[bundle] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
