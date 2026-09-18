import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parsePayloadRelease, requireProductTarget } from "@cinba/installer";
import { buildReleaseBundle } from "./build-release-bundle.ts";
import { renderLinuxBootstrap } from "./linux-install-scripts.ts";

const execute = promisify(execFile);
const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function buildLinuxArtifact(): Promise<{
  artifactPath: string;
  bootstrapPath: string;
  sha256: string;
}> {
  const target = requireProductTarget();
  if (target !== "linux-x64-gnu") {
    throw new Error("Linux artifacts must be built on Linux x64");
  }
  const bundle = await buildReleaseBundle();
  const release = parsePayloadRelease(
    JSON.parse(await readFile(join(bundle, "payload", "release.json"), "utf8")) as unknown,
  );
  const output = join(REPOSITORY_ROOT, "dist", "artifacts");
  await mkdir(output, { recursive: true });
  const artifactName = `Cinba-${release.version}-${target}.tar.gz`;
  const artifactPath = join(output, artifactName);
  await rm(artifactPath, { force: true });
  await execute("tar", ["-czf", artifactPath, "-C", bundle, "."], {
    cwd: REPOSITORY_ROOT,
    windowsHide: true,
  });
  const digest = await sha256(artifactPath);
  const bootstrapPath = join(output, "install.sh");
  await writeFile(
    bootstrapPath,
    renderLinuxBootstrap({
      version: release.version,
      artifactName,
      artifactSha256: digest,
    }),
    { mode: 0o755 },
  );
  await chmod(bootstrapPath, 0o755);
  return { artifactPath, bootstrapPath, sha256: digest };
}

if (import.meta.main) {
  const result = await buildLinuxArtifact();
  console.log(`[artifact] Built ${result.artifactPath}`);
  console.log(`[artifact] SHA-256 ${result.sha256}`);
  console.log(`[artifact] Built ${result.bootstrapPath}`);
}
