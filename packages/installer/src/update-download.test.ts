import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
      builtAt: "2026-09-18T01:02:03Z",
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

test("a complete artifact with the wrong digest is discarded", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-damaged-"));
  const damaged = new Uint8Array(body.byteLength).fill(120);
  try {
    await assert.rejects(
      downloadUpdateCandidate({
        update: update(),
        cacheDirectory: root,
        fetch: async () => new Response(damaged),
      }),
      /does not match|exceeds/,
    );
    const directory = join(root, "updates", revision);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("continues a retained partial artifact with a validated byte range", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-resume-"));
  const candidate = update();
  const directory = join(root, "updates", revision);
  const artifactPath = join(directory, candidate.artifact.fileName);
  const split = 9;
  await mkdir(directory, { recursive: true });
  await writeFile(`${artifactPath}.partial`, body.subarray(0, split));
  try {
    const result = await downloadUpdateCandidate({
      update: candidate,
      cacheDirectory: root,
      fetch: async (_input, init) => {
        assert.equal(new Headers(init?.headers).get("range"), `bytes=${split}-`);
        return new Response(body.subarray(split), {
          status: 206,
          headers: {
            "content-length": String(body.byteLength - split),
            "content-range": `bytes ${split}-${body.byteLength - 1}/${body.byteLength}`,
          },
        });
      },
    });
    assert.deepEqual(new Uint8Array(await readFile(result.artifactPath)), body);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a server without range support safely replaces the partial artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-restart-"));
  const candidate = update();
  const directory = join(root, "updates", revision);
  const artifactPath = join(directory, candidate.artifact.fileName);
  await mkdir(directory, { recursive: true });
  await writeFile(`${artifactPath}.partial`, new TextEncoder().encode("partial"));
  try {
    const result = await downloadUpdateCandidate({
      update: candidate,
      cacheDirectory: root,
      fetch: async () =>
        new Response(body, { headers: { "content-length": String(body.byteLength) } }),
    });
    assert.deepEqual(new Uint8Array(await readFile(result.artifactPath)), body);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a download that cannot connect names GitHub Releases and the network cause", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-offline-"));
  try {
    await assert.rejects(
      downloadUpdateCandidate({
        update: update(),
        cacheDirectory: root,
        fetch: async () => {
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("getaddrinfo ENOTFOUND github.com"), {
              code: "ENOTFOUND",
            }),
          });
        },
      }),
      /^Error: Cinba could not download the update from GitHub Releases \(getaddrinfo ENOTFOUND github\.com\)\.$/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a connection lost mid-download is named and keeps the received bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-dropped-"));
  const candidate = update();
  const partialPath = join(root, "updates", revision, `${candidate.artifact.fileName}.partial`);
  try {
    await assert.rejects(
      downloadUpdateCandidate({
        update: candidate,
        cacheDirectory: root,
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(body.subarray(0, 7));
              },
              pull(controller) {
                controller.error(
                  new TypeError("terminated", {
                    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
                  }),
                );
              },
            }),
          ),
      }),
      /^Error: Cinba could not download the update from GitHub Releases \(read ECONNRESET\)\.$/,
    );
    assert.deepEqual(new Uint8Array(await readFile(partialPath)), body.subarray(0, 7));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation is forwarded without deleting resumable progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-cancel-"));
  const candidate = update();
  const directory = join(root, "updates", revision);
  const artifactPath = join(directory, candidate.artifact.fileName);
  const partial = body.subarray(0, 7);
  const controller = new AbortController();
  await mkdir(directory, { recursive: true });
  await writeFile(`${artifactPath}.partial`, partial);
  try {
    await assert.rejects(
      downloadUpdateCandidate({
        update: candidate,
        cacheDirectory: root,
        signal: controller.signal,
        fetch: async (_input, init) => {
          assert.equal(init?.signal, controller.signal);
          throw new DOMException("cancelled", "AbortError");
        },
      }),
      { name: "AbortError" },
    );
    assert.deepEqual(new Uint8Array(await readFile(`${artifactPath}.partial`)), partial);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
