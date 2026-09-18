import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parsePayloadRelease, requireProductTarget } from "@cinba/installer";
import { buildReleaseBundle } from "./build-release-bundle.ts";
import { renderWindowsInstallerScript } from "./windows-installer-script.ts";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

type NsisTool = { path: string; env?: NodeJS.ProcessEnv };
type NsisTools = { getMakeNsisPath(version?: "0.0.0"): Promise<NsisTool> };

export async function buildWindowsArtifact(): Promise<string> {
  if (requireProductTarget() !== "windows-x64") {
    throw new Error("Windows artifacts must be built on Windows x64");
  }
  const bundle = await buildReleaseBundle();
  const release = parsePayloadRelease(
    JSON.parse(await readFile(join(bundle, "payload", "release.json"), "utf8")) as unknown,
  );
  const output = join(REPOSITORY_ROOT, "dist", "artifacts");
  await mkdir(output, { recursive: true });
  const artifactPath = join(output, `Cinba-${release.version}-windows-x64.exe`);
  const scriptPath = join(output, "windows-installer.nsi");
  await rm(artifactPath, { force: true });
  await writeFile(
    scriptPath,
    renderWindowsInstallerScript({
      version: release.version,
      bundleDirectory: resolve(bundle),
      outputPath: resolve(artifactPath),
    }),
  );
  const tools = require("app-builder-lib/out/toolsets/windows.js") as NsisTools;
  const makensis = await tools.getMakeNsisPath("0.0.0");
  await execute(makensis.path, ["-V2", "-INPUTCHARSET", "UTF8", scriptPath], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, ...makensis.env },
    windowsHide: true,
  });
  return artifactPath;
}

if (import.meta.main) {
  console.log(`[artifact] Built ${await buildWindowsArtifact()}`);
}
