import assert from "node:assert/strict";
import test from "node:test";
import type { UpdateState } from "@cinba/installer";
import {
  checkForProductUpdatesAutomatically,
  parseProductUpdateReadinessJson,
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

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolvePromise = settle;
  });
  return { promise, resolve: resolvePromise };
}

function contention(): Error {
  return new Error("another Cinba update operation is active");
}

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

test("terminal lease contention reads shared state once and returns", async () => {
  let reads = 0;
  const updates: unknown[] = [];
  const result = await checkForProductUpdatesAutomatically(
    {
      release,
      paths: {
        stateDirectory: "C:\\state",
        cacheDirectory: "C:\\cache",
      },
      onUpdate: (update) => updates.push(update),
    },
    {
      prepare: async () => {
        throw contention();
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
  assert.deepEqual(updates, [{ phase: "current" }]);
});

test("lease contention observes shared progress until ready", async () => {
  const ready: UpdateState = { ...current, phase: "ready", candidate };
  const shared: UpdateState[] = [
    { ...current, phase: "checking" },
    {
      ...current,
      phase: "downloading",
      candidate: { ...candidate, artifactPath: null },
    },
    ready,
  ];
  const updates: unknown[] = [];
  const intervals: number[] = [];
  let preparations = 0;
  let reads = 0;

  const result = await checkForProductUpdatesAutomatically(
    {
      release,
      paths: {
        stateDirectory: "C:\\state",
        cacheDirectory: "C:\\cache",
      },
      onUpdate: (update) => updates.push(update),
    },
    {
      prepare: async () => {
        preparations += 1;
        throw contention();
      },
      readState: async () => {
        const state = shared[reads]!;
        reads += 1;
        return state;
      },
      delay: async (milliseconds) => {
        intervals.push(milliseconds);
      },
    },
  );

  assert.equal(result, ready);
  assert.equal(preparations, 3);
  assert.equal(reads, 3);
  assert.deepEqual(updates, [
    { phase: "checking" },
    { phase: "downloading" },
    { phase: "ready", candidateVersion: "0.2.0" },
  ]);
  assert.equal(intervals.length, 2);
  assert.ok(intervals.every((interval) => interval > 0 && interval === intervals[0]));
});

test("a stale contending owner can be replaced by a later prepare attempt", async () => {
  const ready: UpdateState = { ...current, phase: "ready", candidate };
  const updates: unknown[] = [];
  let preparations = 0;

  const result = await checkForProductUpdatesAutomatically(
    {
      release,
      paths: {
        stateDirectory: "C:\\state",
        cacheDirectory: "C:\\cache",
      },
      onUpdate: (update) => updates.push(update),
    },
    {
      prepare: async () => {
        preparations += 1;
        if (preparations === 1) {
          throw contention();
        }
        return ready;
      },
      readState: async () => ({ ...current, phase: "checking" }),
      delay: async () => {},
    },
  );

  assert.equal(result, ready);
  assert.equal(preparations, 2);
  assert.deepEqual(updates, [{ phase: "checking" }, { phase: "ready", candidateVersion: "0.2.0" }]);
});

test("abort stops contention waiting without later updates", async () => {
  const controller = new AbortController();
  const delayStarted = deferred<void>();
  const finishDelay = deferred<void>();
  const updates: unknown[] = [];
  let preparations = 0;
  const running = checkForProductUpdatesAutomatically(
    {
      release,
      paths: {
        stateDirectory: "C:\\state",
        cacheDirectory: "C:\\cache",
      },
      signal: controller.signal,
      onUpdate: (update) => updates.push(update),
    },
    {
      prepare: async () => {
        preparations += 1;
        throw contention();
      },
      readState: async () => ({ ...current, phase: "checking" }),
      delay: async () => {
        delayStarted.resolve();
        await finishDelay.promise;
      },
    },
  );

  assert.equal(
    await Promise.race([
      delayStarted.promise.then(() => true),
      new Promise<boolean>((settle) => setImmediate(() => settle(false))),
    ]),
    true,
  );
  assert.deepEqual(updates, [{ phase: "checking" }]);
  controller.abort();
  assert.equal(await running, undefined);
  finishDelay.resolve();
  await new Promise<void>((settle) => setImmediate(settle));
  assert.equal(preparations, 1);
  assert.deepEqual(updates, [{ phase: "checking" }]);
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

test("automatic update checks report checking, downloading, and ready in order", async () => {
  const updates: unknown[] = [];
  await checkForProductUpdatesAutomatically(
    {
      release,
      paths: {
        stateDirectory: "C:\\state",
        cacheDirectory: "C:\\cache",
      },
      onUpdate: (update) => updates.push(update),
    },
    {
      prepare: async (options) => {
        const report = (
          options as typeof options & {
            onStateChange?: (state: UpdateState) => void;
          }
        ).onStateChange;
        report?.({ ...current, phase: "checking" });
        report?.({
          ...current,
          phase: "downloading",
          candidate: { ...candidate, artifactPath: null },
        });
        const ready = { ...current, phase: "ready" as const, candidate };
        report?.(ready);
        return ready;
      },
    },
  );

  assert.deepEqual(updates, [
    { phase: "checking" },
    { phase: "downloading" },
    { phase: "ready", candidateVersion: "0.2.0" },
  ]);
});

test("automatic update errors report idle without exposing the failure", async () => {
  const updates: unknown[] = [];
  await checkForProductUpdatesAutomatically(
    {
      release,
      paths: {
        stateDirectory: "C:\\state",
        cacheDirectory: "C:\\cache",
      },
      onUpdate: (update) => updates.push(update),
    },
    {
      prepare: async (options) => {
        const report = (
          options as typeof options & {
            onStateChange?: (state: UpdateState) => void;
          }
        ).onStateChange;
        report?.({ ...current, phase: "checking" });
        throw new Error("network details");
      },
      readState: async () => ({
        ...current,
        phase: "failed",
        failure: "discovery-failed",
      }),
    },
  );

  assert.deepEqual(updates, [{ phase: "checking" }, { phase: "idle" }]);
});

test("automatic system failures recover from state as visible blocked updates", async () => {
  for (const [failure, reason] of [
    ["system-incompatible", "incompatible"],
    ["system-unverified", "unverified"],
  ] as const) {
    const updates: unknown[] = [];
    await checkForProductUpdatesAutomatically(
      {
        release,
        paths: { stateDirectory: "C:\\state", cacheDirectory: "C:\\cache" },
        onUpdate: (update) => updates.push(update),
      },
      {
        prepare: async () => {
          throw new Error("detailed system information belongs to the explicit command");
        },
        readState: async () => ({
          ...current,
          phase: "failed",
          candidate: { ...candidate, artifactPath: null },
          failure,
        }),
      },
    );
    assert.deepEqual(updates, [
      {
        phase: "blocked",
        reason,
        candidateVersion: "0.2.0",
        message:
          reason === "incompatible"
            ? "Cinba 0.2.0 requires a newer system and cannot be installed. Run cinba update for details."
            : "Cinba 0.2.0 system compatibility is unknown, so it cannot be installed. Run cinba update for details.",
      },
    ]);
  }
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
  assert.deepEqual(
    toAutomaticUpdateViewModel({
      ...current,
      phase: "failed",
      candidate,
      failure: "download-failed",
    }),
    { phase: "idle" },
  );
  assert.deepEqual(
    toAutomaticUpdateViewModel({
      ...current,
      phase: "failed",
      candidate,
      failure: "installation-failed",
    }),
    {
      phase: "failed",
      candidateVersion: "0.2.0",
      message: "Cinba 0.2.0 could not be installed. Run cinba update to retry.",
    },
  );
  assert.deepEqual(
    toAutomaticUpdateViewModel({
      ...current,
      phase: "failed",
      candidate: { ...candidate, artifactPath: null },
      failure: "system-incompatible",
    }),
    {
      phase: "blocked",
      reason: "incompatible",
      candidateVersion: "0.2.0",
      message:
        "Cinba 0.2.0 requires a newer system and cannot be installed. Run cinba update for details.",
    },
  );
  assert.deepEqual(
    toAutomaticUpdateViewModel({
      ...current,
      phase: "failed",
      candidate: { ...candidate, artifactPath: null },
      failure: "system-unverified",
    }),
    {
      phase: "blocked",
      reason: "unverified",
      candidateVersion: "0.2.0",
      message:
        "Cinba 0.2.0 system compatibility is unknown, so it cannot be installed. Run cinba update for details.",
    },
  );
});

test("readiness JSON parser accepts only the exact bounded protocol", () => {
  assert.deepEqual(parseProductUpdateReadinessJson('{"status":"ready"}'), { status: "ready" });
  assert.deepEqual(
    parseProductUpdateReadinessJson(
      '{"status":"waiting","reasonCode":"core-active-work","message":"Core has active work"}',
    ),
    {
      status: "waiting",
      reasonCode: "core-active-work",
      message: "Core has active work",
    },
  );
  for (const value of [
    '{"status":"ready","message":"extra"}',
    '{"status":"waiting","reasonCode":"unknown","message":"wait"}',
    '{"status":"waiting","reasonCode":"core-active-work","message":"wait","extra":true}',
    '{"status":"waiting","reasonCode":"core-active-work","message":""}',
    JSON.stringify({
      status: "waiting",
      reasonCode: "core-active-work",
      message: "x".repeat(2_049),
    }),
    '{"status":"ready"}\n{"status":"ready"}',
  ]) {
    assert.throws(() => parseProductUpdateReadinessJson(value), /update readiness JSON is invalid/);
  }
});
