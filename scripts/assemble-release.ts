import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRODUCT_DATA_FORMAT_VERSION,
  PRODUCT_PROTOCOL_VERSION,
  PRODUCT_TARGETS,
  PRODUCT_TARGET_DEFINITIONS,
  RELEASE_MANIFEST_FILE_NAME,
  type ReleaseArtifact,
  type ReleaseManifest,
  parseReleaseManifest,
} from "@cinba/installer";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHA256SUMS_FILE_NAME = "SHA256SUMS";
const INSTALL_SCRIPT_FILE_NAME = "install.sh";

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function artifactName(version: string, target: (typeof PRODUCT_TARGETS)[number]): string {
  return `Cinba-${version}-${target}${PRODUCT_TARGET_DEFINITIONS[target].artifactExtension}`;
}

async function releaseArtifact(
  directory: string,
  version: string,
  target: (typeof PRODUCT_TARGETS)[number],
): Promise<ReleaseArtifact> {
  const fileName = artifactName(version, target);
  const path = join(directory, fileName);
  const file = await stat(path);
  if (!file.isFile() || file.size < 1) {
    throw new Error(`release artifact is missing or empty: ${fileName}`);
  }
  const common = { fileName, size: file.size, sha256: await sha256(path) };
  const minimum = PRODUCT_TARGET_DEFINITIONS[target].minimumSystem;
  if (target === "windows-x64") {
    if (minimum.platform !== "windows") {
      throw new Error("Windows platform baseline is invalid");
    }
    return { target, ...common, minimumSystem: { version: minimum.version } };
  }
  if (target === "macos-arm64") {
    if (minimum.platform !== "macos") {
      throw new Error("macOS platform baseline is invalid");
    }
    return { target, ...common, minimumSystem: { version: minimum.version } };
  }
  if (minimum.platform !== "linux-gnu") {
    throw new Error("Linux platform baseline is invalid");
  }
  return {
    target,
    ...common,
    minimumSystem: { kernel: minimum.kernel, glibc: minimum.glibc },
  };
}

export async function assembleRelease(options: {
  artifactsDirectory: string;
  version: string;
  revision: string;
  builtAt: string;
}): Promise<{ manifestPath: string; checksumsPath: string; manifest: ReleaseManifest }> {
  if (!isAbsolute(options.artifactsDirectory)) {
    throw new Error("release artifactsDirectory must be absolute");
  }
  if (!/^\d+\.\d+\.\d+$/.test(options.version)) {
    throw new Error("release version must be a stable SemVer");
  }
  if (!/^[0-9a-f]{40}$/.test(options.revision)) {
    throw new Error("release revision must be a full lowercase Git commit");
  }
  if (!options.builtAt.endsWith("Z") || Number.isNaN(Date.parse(options.builtAt))) {
    throw new Error("release builtAt must be an ISO UTC timestamp");
  }
  const directory = resolve(options.artifactsDirectory);
  const installScript = join(directory, INSTALL_SCRIPT_FILE_NAME);
  const installScriptStatus = await stat(installScript);
  if (!installScriptStatus.isFile() || installScriptStatus.size < 1) {
    throw new Error("release install.sh is missing or empty");
  }
  const artifacts = await Promise.all(
    PRODUCT_TARGETS.map((target) => releaseArtifact(directory, options.version, target)),
  );
  const manifest = parseReleaseManifest({
    schemaVersion: 1,
    product: "Cinba",
    version: options.version,
    revision: options.revision,
    protocolVersion: PRODUCT_PROTOCOL_VERSION,
    dataFormatVersion: PRODUCT_DATA_FORMAT_VERSION,
    builtAt: options.builtAt,
    artifacts,
  });
  const manifestPath = join(directory, RELEASE_MANIFEST_FILE_NAME);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const checksumNames = [
    ...artifacts.map((artifact) => artifact.fileName),
    INSTALL_SCRIPT_FILE_NAME,
    RELEASE_MANIFEST_FILE_NAME,
  ].toSorted();
  const checksumLines = await Promise.all(
    checksumNames.map(
      async (fileName) => `${await sha256(join(directory, fileName))}  ${fileName}`,
    ),
  );
  const checksumsPath = join(directory, SHA256SUMS_FILE_NAME);
  await writeFile(checksumsPath, `${checksumLines.join("\n")}\n`);
  return { manifestPath, checksumsPath, manifest };
}

function gitRevision(): string {
  const revision = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  })
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error("Git did not return a full release revision");
  }
  return revision;
}

async function packageVersion(): Promise<string> {
  const parsed = JSON.parse(await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof parsed.version !== "string") {
    throw new Error("root package.json does not contain a product version");
  }
  return parsed.version;
}

if (import.meta.main) {
  const artifactsDirectory = resolve(process.argv[2] ?? join(REPOSITORY_ROOT, "dist", "artifacts"));
  const result = await assembleRelease({
    artifactsDirectory,
    version: await packageVersion(),
    revision: gitRevision(),
    builtAt: new Date().toISOString(),
  });
  console.log(`[release] Built ${basename(result.manifestPath)}`);
  console.log(`[release] Built ${basename(result.checksumsPath)}`);
}
