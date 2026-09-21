import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Arch, type Configuration, Platform, build as buildElectron } from "electron-builder";
import { build } from "esbuild";
import { parsePayloadRelease, requireProductTarget } from "@cinba/installer";
import { buildReleaseBundle } from "./build-release-bundle.ts";
import { verifyMacosApplicationSignature } from "./verify-macos-application.ts";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MACOS_INSTALLER_DIST = join(REPOSITORY_ROOT, "dist", "macos-installer");
const STAGING_DIRECTORY = join(MACOS_INSTALLER_DIST, "app");

export function createMacosArtifactConfiguration(options: {
  version: string;
  bundleDirectory: string;
  outputDirectory: string;
}): Configuration {
  if (!/^\d+\.\d+\.\d+$/.test(options.version)) {
    throw new Error("macOS artifacts require a stable SemVer");
  }
  if (!isAbsolute(options.bundleDirectory) || !isAbsolute(options.outputDirectory)) {
    throw new Error("macOS artifact paths must be absolute");
  }
  return {
    appId: "com.soundoer.cinba.installer",
    productName: "Cinba",
    asar: true,
    npmRebuild: false,
    directories: {
      app: STAGING_DIRECTORY,
      output: options.outputDirectory,
    },
    files: ["**/*"],
    extraResources: [{ from: options.bundleDirectory, to: "cinba-bundle" }],
    extraMetadata: { version: options.version },
    mac: {
      appId: "com.soundoer.cinba.installer",
      category: "public.app-category.developer-tools",
      // A release certificate is intentionally optional for this personal build, but Electron's
      // nested frameworks still need one coherent signature. Skipping signing leaves their linker
      // signatures in a bundle that macOS rejects before the installer bootstrap can run.
      identity: "-",
      hardenedRuntime: false,
      // The release bundle contains the already signed installed Desktop. Re-signing its nested
      // frameworks as loose resources breaks their bundle topology; the outer signature still
      // seals their bytes as installer resources.
      signIgnore: "Contents/Resources/cinba-bundle/desktop/",
      artifactName: `Cinba-${options.version}-macos-arm64.\${ext}`,
    },
    dmg: {
      sign: false,
      backgroundColor: "#f4f4f4",
      window: { width: 540, height: 380 },
      contents: [{ x: 270, y: 180, type: "file" }],
    },
  };
}

async function prepareInstallerApplication(version: string): Promise<void> {
  await rm(STAGING_DIRECTORY, { recursive: true, force: true });
  await mkdir(join(STAGING_DIRECTORY, "lib"), { recursive: true });
  await build({
    absWorkingDir: REPOSITORY_ROOT,
    entryPoints: ["packages/desktop/src/macos-installer-bootstrap.ts"],
    outfile: join(STAGING_DIRECTORY, "lib", "bootstrap.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    external: ["electron"],
    sourcemap: false,
    legalComments: "none",
  });
  await writeFile(
    join(STAGING_DIRECTORY, "package.json"),
    `${JSON.stringify(
      {
        name: "cinba-macos-installer",
        description: "Cinba user installer for macOS.",
        author: "SounDoer",
        private: true,
        type: "module",
        version,
        main: "lib/bootstrap.mjs",
      },
      null,
      2,
    )}\n`,
  );
}

export async function buildMacosArtifact(): Promise<string> {
  if (requireProductTarget() !== "macos-arm64") {
    throw new Error("macOS artifacts must be built on macOS Apple Silicon");
  }
  const bundle = await buildReleaseBundle();
  const release = parsePayloadRelease(
    JSON.parse(await readFile(join(bundle, "payload", "release.json"), "utf8")) as unknown,
  );
  await prepareInstallerApplication(release.version);
  const outputDirectory = join(REPOSITORY_ROOT, "dist", "artifacts");
  await mkdir(outputDirectory, { recursive: true });
  const artifactPath = join(outputDirectory, `Cinba-${release.version}-macos-arm64.dmg`);
  await rm(artifactPath, { force: true });
  const outputs = await buildElectron({
    targets: Platform.MAC.createTarget("dmg", Arch.arm64),
    publish: "never",
    config: createMacosArtifactConfiguration({
      version: release.version,
      bundleDirectory: bundle,
      outputDirectory,
    }),
  });
  await verifyMacosApplicationSignature(join(outputDirectory, "mac-arm64", "Cinba.app"));
  if (!outputs.includes(artifactPath)) {
    throw new Error("macOS artifact build did not produce the expected DMG");
  }
  return artifactPath;
}

if (import.meta.main) {
  console.log(`[artifact] Built ${await buildMacosArtifact()}`);
}
