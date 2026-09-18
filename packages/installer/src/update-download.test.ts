import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { UpdateDiscovery } from "./update-discovery.ts";
import { downloadUpdateCandidate } from "./update-download.ts";

const body = new TextEncoder().encode("complete Cinba artifact");
const sha256 = createHash("sha256").update(body).digest("hex");
const revision = "a".repeat(40);

function update(): Extract<UpdateDiscovery, { state: "available" }> {
  return {
    state: "available",
    currentVersion: "0.1.0",
    latestVersion: "0.2.0",
    releaseUrl: "https://github.com/SounDoer/Cinba/releases/tag/v0.2.0",
    downloadUrl:
      "https://github.com/SounDoer/Cinba/releases/download/v0.2.0/Cinba-0.2.0-windows-x64.exe",
    artifact: {
      target: "windows-x64",
      fileName: "Cinba-0.2.0-windows-x64.exe",
      size: body.byteLength,
      sha256,
      minimumSystem: { version: "10.0" },
    },
    manifest: {
      schemaVersion: 1,
      product: "Cinba",
      version: "0.2.0",
      revision,
      protocolVersion: 1,
      dataFormatVersion: 1,
      publishedAt: "2026-09-18T01:02:03Z",
      artifacts: [
        {
          target: "windows-x64",
          fileName: "Cinba-0.2.0-windows-x64.exe",
          size: body.byteLength,
          sha256,
          minimumSystem: { version: "10.0" },
        },
        {
          target: "macos-arm64",
          fileName: "Cinba-0.2.0-macos-arm64.dmg",
          size: 1,
          sha256: "b".repeat(64),
          minimumSystem: { version: "13.5" },
        },
        {
          target: "linux-x64-gnu",
          fileName: "Cinba-0.2.0-linux-x64-gnu.tar.gz",
          size: 1,
          sha256: "c".repeat(64),
          minimumSystem: { kernel: "4.18", glibc: "2.28" },
        },
      ],
    },
  };
}

test("downloads and atomically verifies one target artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-download-"));
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests += 1;
    return new Response(body, { headers: { "content-length": String(body.byteLength) } });
  };
  try {
    const first = await downloadUpdateCandidate({
      update: update(),
      cacheDirectory: root,
      fetch: fetcher,
    });
    assert.equal(first.reused, false);
    assert.deepEqual(new Uint8Array(await readFile(first.artifactPath)), body);
    const second = await downloadUpdateCandidate({
      update: update(),
      cacheDirectory: root,
      fetch: fetcher,
    });
    assert.equal(second.reused, true);
    assert.equal(requests, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a damaged download never becomes a ready cache artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-damaged-"));
  try {
    await assert.rejects(
      downloadUpdateCandidate({
        update: update(),
        cacheDirectory: root,
        fetch: async () => new Response(new TextEncoder().encode("wrong artifact content!!")),
      }),
      /does not match|exceeds/,
    );
    const directory = join(root, "updates", revision);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
