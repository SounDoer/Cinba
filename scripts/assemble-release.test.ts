import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseReleaseManifest } from "@cinba/installer";
import { assembleRelease } from "./assemble-release.ts";

const VERSION = "1.2.3";
const REVISION = "a".repeat(40);
const ARTIFACT_NAMES = [
  `Cinba-${VERSION}-windows-x64.exe`,
  `Cinba-${VERSION}-macos-arm64.dmg`,
  `Cinba-${VERSION}-linux-x64-gnu.tar.gz`,
];

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cinba-release-assembly-"));
  for (const name of [...ARTIFACT_NAMES, "install.sh"]) {
    await writeFile(join(directory, name), `content:${name}`);
  }
  return directory;
}

test("one complete platform set becomes a strict manifest and checksum list", async () => {
  const directory = await fixture();
  try {
    const result = await assembleRelease({
      artifactsDirectory: directory,
      version: VERSION,
      revision: REVISION,
      builtAt: "2026-09-18T00:00:00.000Z",
    });
    const manifest = parseReleaseManifest(
      JSON.parse(await readFile(result.manifestPath, "utf8")) as unknown,
    );
    assert.equal(manifest.version, VERSION);
    assert.equal(manifest.revision, REVISION);
    assert.deepEqual(
      manifest.artifacts.map((artifact) => artifact.fileName),
      ARTIFACT_NAMES,
    );
    const checksums = await readFile(result.checksumsPath, "utf8");
    for (const name of [...ARTIFACT_NAMES, "install.sh", "cinba-release.json"]) {
      assert.match(checksums, new RegExp(`^[0-9a-f]{64}  ${name.replaceAll(".", "\\.")}$`, "m"));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release assembly refuses an incomplete platform set", async () => {
  const directory = await fixture();
  try {
    await rm(join(directory, ARTIFACT_NAMES[1]!));
    await assert.rejects(
      assembleRelease({
        artifactsDirectory: directory,
        version: VERSION,
        revision: REVISION,
        builtAt: "2026-09-18T00:00:00.000Z",
      }),
      /macos-arm64\.dmg/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release assembly validates version and revision before publishing metadata", async () => {
  const directory = await fixture();
  try {
    await assert.rejects(
      assembleRelease({
        artifactsDirectory: directory,
        version: "latest",
        revision: REVISION,
        builtAt: "2026-09-18T00:00:00.000Z",
      }),
      /release version must be a stable SemVer/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
