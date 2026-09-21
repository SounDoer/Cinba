import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Arch, type Configuration, Platform, build as buildElectron } from "electron-builder";
import { build } from "esbuild";
import { requireProductTarget } from "@cinba/installer";
import { verifyMacosApplicationSignature } from "./verify-macos-application.ts";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DESKTOP_DIST = join(REPOSITORY_ROOT, "dist", "desktop");
const STAGING_DIRECTORY = join(DESKTOP_DIST, "app");

type RootPackage = { version?: unknown };

async function productVersion(): Promise<string> {
  const parsed = JSON.parse(
    await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8"),
  ) as RootPackage;
  if (typeof parsed.version !== "string" || !/^\d+\.\d+\.\d+$/.test(parsed.version)) {
    throw new Error("Desktop releases require a stable SemVer in root package.json");
  }
  return parsed.version;
}

export function createDesktopBuildConfiguration(options: {
  version: string;
  outputDirectory: string;
}): Configuration {
  return {
    appId: "com.soundoer.cinba",
    productName: "Cinba",
    asar: true,
    npmRebuild: false,
    directories: {
      app: STAGING_DIRECTORY,
      output: options.outputDirectory,
    },
    files: ["**/*"],
    extraMetadata: { version: options.version },
    win: {
      executableName: "Cinba",
      signExecutable: false,
    },
    mac: {
      appId: "com.soundoer.cinba",
      category: "public.app-category.developer-tools",
      identity: "-",
      hardenedRuntime: false,
    },
  };
}

async function prepareDesktopApplication(version: string): Promise<void> {
  await rm(STAGING_DIRECTORY, { recursive: true, force: true });
  await mkdir(join(STAGING_DIRECTORY, "lib"), { recursive: true });
  await build({
    absWorkingDir: REPOSITORY_ROOT,
    entryPoints: ["packages/desktop/src/installed-bootstrap.ts"],
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
        name: "cinba-desktop",
        description: "Cinba desktop client and local Core controller.",
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

export async function buildDesktopApplication(): Promise<string[]> {
  const target = requireProductTarget();
  if (target === "linux-x64-gnu") {
    throw new Error("Cinba Desktop is released only for Windows x64 and macOS Apple Silicon");
  }
  const version = await productVersion();
  await prepareDesktopApplication(version);
  const outputDirectory = join(DESKTOP_DIST, target);
  await rm(outputDirectory, { recursive: true, force: true });
  const targets =
    target === "windows-x64"
      ? Platform.WINDOWS.createTarget("dir", Arch.x64)
      : Platform.MAC.createTarget("dir", Arch.arm64);
  const outputs = await buildElectron({
    targets,
    publish: "never",
    config: createDesktopBuildConfiguration({ version, outputDirectory }),
  });
  const fallbackOutput =
    target === "windows-x64"
      ? join(outputDirectory, "win-unpacked")
      : join(outputDirectory, "mac-arm64", "Cinba.app");
  if (target === "macos-arm64") {
    await verifyMacosApplicationSignature(fallbackOutput);
  }
  return outputs.length > 0 ? outputs : [fallbackOutput];
}

if (import.meta.main) {
  buildDesktopApplication()
    .then((outputs) => console.log(`[desktop] Built ${outputs.join(", ")}`))
    .catch((error: unknown) => {
      console.error(`[desktop] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
