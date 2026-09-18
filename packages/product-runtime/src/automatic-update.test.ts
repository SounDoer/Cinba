import assert from "node:assert/strict";
import test from "node:test";
import type { UpdateState } from "@cinba/installer";
import {
  checkForProductUpdatesAutomatically,
  toAutomaticUpdateViewModel,
} from "./automatic-update.ts";
import type { ProductRelease } from "./release.ts";

const release: ProductRelease = {
  schemaVersion: 1,
  product: "Cinba",
  version: "0.1.0",
  revision: "a".repeat(40),
  protocolVersion: 1,
  dataFormatVersion: 1,
  target: "windows-x64",
  nodeVersion: "24.0.0",
};

const current: UpdateState = {
  schemaVersion: 1,
  phase: "current",
  currentVersion: "0.1.0",
  checkedAt: "2026-09-18T01:00:00.000Z",
  candidate: null,
  failure: null,
};

const candidate = {
  version: "0.2.0",
  revision: "b".repeat(40),
  target: "windows-x64" as const,
  artifactPath: "C:\\cache\\Cinba.exe",
  size: 42,
  sha256: "c".repeat(64),
  releaseUrl: "https://github.com/SounDoer/Cinba/releases/tag/v0.2.0",
};

test("automatic update checks delegate identity, shared paths, and automatic mode", async () => {
  let received: unknown;
  const controller = new AbortController();
  const result = await checkForProductUpdatesAutomatically(
    {
      release,
      paths: {
        stateDirectory: "C:\\state",
        cacheDirectory: "C:\\cache",
      },
      signal: controller.signal,
    },
    {
      prepare: async (options) => {
        received = options;
        return current;
      },
    },
  );

  assert.deepEqual(received, {
    currentVersion: "0.1.0",
    currentRevision: "a".repeat(40),
    target: "windows-x64",
    stateDirectory: "C:\\state",
    cacheDirectory: "C:\\cache",
    automatic: true,
    signal: controller.signal,
  });
  assert.equal(result, current);
});

test("automatic update checks return a recent state reused by the lower layer", async () => {
  assert.equal(
    await checkForProductUpdatesAutomatically(
      {
        release,
        paths: {
          stateDirectory: "C:\\state",
          cacheDirectory: "C:\\cache",
        },
      },
      { prepare: async () => current },
    ),
    current,
  );
});

test("lease contention falls back to the latest shared state", async () => {
  let reads = 0;
  const result = await checkForProductUpdatesAutomatically(
    {
      release,
      paths: {
        stateDirectory: "C:\\state",
        cacheDirectory: "C:\\cache",
      },
    },
    {
      prepare: async () => {
        throw new Error("another Cinba update operation is active");
      },
      readState: async (stateDirectory) => {
        reads += 1;
        assert.equal(stateDirectory, "C:\\state");
        return current;
      },
    },
  );

  assert.equal(result, current);
  assert.equal(reads, 1);
});

test("automatic update failures remain silent when no state can be read", async () => {
  const result = await checkForProductUpdatesAutomatically(
    {
      release,
      paths: {
        stateDirectory: "C:\\state",
        cacheDirectory: "C:\\cache",
      },
    },
    {
      prepare: async () => {
        throw new Error("network details");
      },
      readState: async () => {
        throw new Error("invalid shared state");
      },
    },
  );

  assert.equal(result, undefined);
});

test("strict update states map to a minimal foreground view", () => {
  assert.deepEqual(toAutomaticUpdateViewModel(undefined), { phase: "idle" });
  assert.deepEqual(toAutomaticUpdateViewModel(current), { phase: "current" });
  assert.deepEqual(toAutomaticUpdateViewModel({ ...current, phase: "checking" }), {
    phase: "checking",
  });
  assert.deepEqual(
    toAutomaticUpdateViewModel({
      ...current,
      phase: "downloading",
      candidate: { ...candidate, artifactPath: null },
    }),
    { phase: "downloading" },
  );
  assert.deepEqual(toAutomaticUpdateViewModel({ ...current, phase: "ready", candidate }), {
    phase: "ready",
    candidateVersion: "0.2.0",
  });
  assert.deepEqual(
    toAutomaticUpdateViewModel({
      ...current,
      phase: "failed",
      failure: "discovery-failed",
    }),
    { phase: "idle" },
  );
});
