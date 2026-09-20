import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import { parseReleaseManifest } from "@cinba/installer";
import { assembleRelease } from "./assemble-release.ts";

const VERSION = "1.2.3";
const REVISION = "a".repeat(40);
const ARTIFACT_NAMES = [
  `Cinba-${VERSION}-windows-x64.exe`,
  `Cinba-${VERSION}-macos-arm64.dmg`,
  `Cinba-${VERSION}-linux-x64-gnu.tar.gz`,
];

async function fixture(t: TestContext): Promise<string> {
  const directory = temporaryDirectory("cinba-release-assembly-", t);
  for (const name of [...ARTIFACT_NAMES, "install.sh"]) {
    await writeFile(join(directory, name), `content:${name}`);
  }
  return directory;
}

test("one complete platform set becomes a strict manifest and checksum list", async (t) => {
  const directory = await fixture(t);
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
});

test("release assembly refuses an incomplete platform set", async (t) => {
  const directory = await fixture(t);
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
});

test("release assembly validates version and revision before publishing metadata", async (t) => {
  const directory = await fixture(t);
  await assert.rejects(
    assembleRelease({
      artifactsDirectory: directory,
      version: "latest",
      revision: REVISION,
      builtAt: "2026-09-18T00:00:00.000Z",
    }),
    /release version must be a stable SemVer/,
  );
});
