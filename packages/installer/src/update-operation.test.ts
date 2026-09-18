import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { UpdateDiscovery } from "./update-discovery.ts";
import { prepareProductUpdate } from "./update-operation.ts";
import { readUpdateState } from "./update-state.ts";

const revision = "a".repeat(40);

function available(): Extract<UpdateDiscovery, { state: "available" }> {
  return {
    state: "available",
    currentVersion: "0.1.0",
    latestVersion: "0.2.0",
    releaseUrl: "https://github.com/SounDoer/Cinba/releases/tag/v0.2.0",
    downloadUrl: "https://github.com/SounDoer/Cinba/releases/download/v0.2.0/Cinba.exe",
    manifest: {
      schemaVersion: 1,
      product: "Cinba",
      version: "0.2.0",
      revision,
      protocolVersion: 1,
      dataFormatVersion: 1,
      publishedAt: "2026-09-18T01:02:03Z",
      artifacts: [],
    },
    artifact: {
      target: "windows-x64",
      fileName: "Cinba.exe",
      size: 42,
      sha256: "b".repeat(64),
      minimumSystem: { version: "10.0" },
    },
  };
}

test("one update operation advances through discovery and download to ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-operation-"));
  const artifactPath = join(root, "cache", "Cinba.exe");
  const controller = new AbortController();
  const phases: string[] = [];
  try {
    const result = await prepareProductUpdate({
      currentVersion: "0.1.0",
      currentRevision: "0".repeat(40),
      target: "windows-x64",
      stateDirectory: join(root, "state"),
      cacheDirectory: join(root, "cache"),
      now: () => new Date("2026-09-18T01:02:03Z"),
      signal: controller.signal,
      onStateChange: (state) => phases.push(state.phase),
      discover: async (options) => {
        assert.equal(options.signal, controller.signal);
        return available();
      },
      download: async () => ({
        version: "0.2.0",
        revision,
        target: "windows-x64",
        artifactPath,
        size: 42,
        sha256: "b".repeat(64),
        reused: false,
      }),
    });
    assert.equal(result.phase, "ready");
    assert.equal(result.candidate?.artifactPath, artifactPath);
    assert.deepEqual(phases, ["checking", "downloading", "ready"]);
    assert.deepEqual(await readUpdateState(join(root, "state")), result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("download failure leaves a retryable candidate and a safe failure code", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-failure-"));
  try {
    await assert.rejects(
      prepareProductUpdate({
        currentVersion: "0.1.0",
        currentRevision: "0".repeat(40),
        target: "windows-x64",
        stateDirectory: join(root, "state"),
        cacheDirectory: join(root, "cache"),
        discover: async () => available(),
        download: async () => {
          throw new Error("network secret must not persist");
        },
      }),
      /network secret/,
    );
    const saved = await readUpdateState(join(root, "state"));
    assert.equal(saved?.phase, "failed");
    assert.equal(saved?.failure, "download-failed");
    assert.equal(JSON.stringify(saved).includes("network secret"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an incompatible new release fails before artifact download", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-incompatible-"));
  let downloads = 0;
  try {
    await assert.rejects(
      prepareProductUpdate({
        currentVersion: "0.1.0",
        currentRevision: "0".repeat(40),
        target: "windows-x64",
        stateDirectory: join(root, "state"),
        cacheDirectory: join(root, "cache"),
        discover: async () => {
          throw new Error("A new Cinba version exists, but this system is incompatible");
        },
        download: async () => {
          downloads += 1;
          throw new Error("artifact download must not start");
        },
      }),
      /new Cinba version exists.*system is incompatible/,
    );
    assert.equal(downloads, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic callers reuse a recent shared result without another request", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-update-throttle-"));
  let discoveries = 0;
  const common = {
    currentVersion: "0.1.0",
    currentRevision: "0".repeat(40),
    target: "windows-x64" as const,
    stateDirectory: join(root, "state"),
    cacheDirectory: join(root, "cache"),
    automatic: true,
    discover: async () => {
      discoveries += 1;
      return {
        state: "current" as const,
        currentVersion: "0.1.0",
        latestVersion: "0.1.0",
        releaseUrl: "https://github.com/SounDoer/Cinba/releases/tag/v0.1.0",
      };
    },
  };
  try {
    await prepareProductUpdate({ ...common, now: () => new Date("2026-09-18T01:00:00Z") });
    const reused = await prepareProductUpdate({
      ...common,
      now: () => new Date("2026-09-18T02:00:00Z"),
    });
    assert.equal(reused.phase, "current");
    assert.equal(discoveries, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
