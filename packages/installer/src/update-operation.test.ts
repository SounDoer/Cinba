import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import {
  UPDATE_DISCOVERY_FAILURE_CODE,
  type UpdateDiscovery,
  UpdateDiscoveryFailureError,
  UpdateRateLimitError,
} from "./update-discovery.ts";
import { prepareProductUpdate } from "./update-operation.ts";
import { automaticUpdateCheckIsDue, readUpdateState } from "./update-state.ts";

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
      builtAt: "2026-09-18T01:02:03Z",
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

function blockedCandidate() {
  return {
    version: "0.2.0",
    revision,
    target: "windows-x64" as const,
    artifactPath: null,
    size: 42,
    sha256: "b".repeat(64),
    releaseUrl: "https://github.com/SounDoer/Cinba/releases/tag/v0.2.0",
  };
}

test("one update operation advances through discovery and download to ready", async (t) => {
  const root = temporaryDirectory("cinba-update-operation-", t);
  const artifactPath = join(root, "cache", "Cinba.exe");
  const controller = new AbortController();
  const phases: string[] = [];
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
});

test("download failure leaves a retryable candidate and a safe failure code", async (t) => {
  const root = temporaryDirectory("cinba-update-failure-", t);
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
});

for (const failure of ["system-incompatible", "system-unverified"] as const) {
  test(`${failure} retains the candidate and fails before artifact download`, async (t) => {
    const root = temporaryDirectory(`cinba-update-${failure}-`, t);
    let downloads = 0;
    const update = available();
    await assert.rejects(
      prepareProductUpdate({
        currentVersion: "0.1.0",
        currentRevision: "0".repeat(40),
        target: "windows-x64",
        stateDirectory: join(root, "state"),
        cacheDirectory: join(root, "cache"),
        discover: async () => {
          throw new UpdateDiscoveryFailureError(failure, update, `detailed ${failure} error`);
        },
        download: async () => {
          downloads += 1;
          throw new Error("artifact download must not start");
        },
      }),
      new RegExp(`detailed ${failure} error`),
    );
    assert.equal(downloads, 0);
    const saved = await readUpdateState(join(root, "state"));
    assert.equal(saved?.phase, "failed");
    assert.equal(saved?.failure, failure);
    assert.deepEqual(saved?.candidate, blockedCandidate());
  });
}

test("plain structural system failure survives a cross-realm boundary", async (t) => {
  const root = temporaryDirectory("cinba-update-cross-realm-", t);
  let downloads = 0;
  let rejected = false;
  try {
    await prepareProductUpdate({
      currentVersion: "0.1.0",
      currentRevision: "0".repeat(40),
      target: "windows-x64",
      stateDirectory: join(root, "state"),
      cacheDirectory: join(root, "cache"),
      discover: async () => {
        throw new Proxy(
          {
            code: UPDATE_DISCOVERY_FAILURE_CODE,
            failure: "system-incompatible",
            candidate: blockedCandidate(),
            message: "cross-realm compatibility detail",
          },
          {
            get: () => {
              throw new Error("operation must not reread the original error");
            },
          },
        );
      },
      download: async () => {
        downloads += 1;
        throw new Error("artifact download must not start");
      },
    });
  } catch {
    rejected = true;
    // The state below is authoritative; do not inspect the hostile rejection object.
  }
  assert.equal(rejected, true);
  assert.equal(downloads, 0);
  const saved = await readUpdateState(join(root, "state"));
  assert.equal(saved?.failure, "system-incompatible");
  assert.deepEqual(saved?.candidate, blockedCandidate());
});

test("spoofed structural failures degrade to safe discovery failure state", async (t) => {
  const invalidFailures = [
    {
      code: UPDATE_DISCOVERY_FAILURE_CODE,
      failure: "download-failed",
      candidate: blockedCandidate(),
      message: "wrong failure",
    },
    {
      code: UPDATE_DISCOVERY_FAILURE_CODE,
      failure: "system-incompatible",
      candidate: { ...blockedCandidate(), artifactPath: "C:\\unsafe.exe" },
      message: "unsafe candidate",
    },
    {
      code: UPDATE_DISCOVERY_FAILURE_CODE,
      failure: "system-unverified",
      candidate: { ...blockedCandidate(), unexpected: true },
      message: "invalid candidate",
    },
    {
      code: UPDATE_DISCOVERY_FAILURE_CODE,
      failure: "system-incompatible",
      candidate: { ...blockedCandidate(), target: "macos-arm64" },
      message: "wrong target",
    },
    {
      code: UPDATE_DISCOVERY_FAILURE_CODE,
      failure: "system-incompatible",
      candidate: { ...blockedCandidate(), version: "0.1.0" },
      message: "current version",
    },
    {
      code: UPDATE_DISCOVERY_FAILURE_CODE,
      failure: "system-incompatible",
      candidate: { ...blockedCandidate(), version: "0.0.9" },
      message: "older version",
    },
    {
      failure: "system-incompatible",
      candidate: blockedCandidate(),
      message: "missing discriminator",
    },
  ];
  for (const [index, invalid] of invalidFailures.entries()) {
    const root = temporaryDirectory(`cinba-update-spoof-${index}-`, t);
    await assert.rejects(
      prepareProductUpdate({
        currentVersion: "0.1.0",
        currentRevision: "0".repeat(40),
        target: "windows-x64",
        stateDirectory: join(root, "state"),
        cacheDirectory: join(root, "cache"),
        discover: async () => {
          throw invalid;
        },
      }),
    );
    const saved = await readUpdateState(join(root, "state"));
    assert.equal(saved?.failure, "discovery-failed");
    assert.equal(saved?.candidate, null);
  }
});

test("automatic callers reuse a recent shared result without another request", async (t) => {
  const root = temporaryDirectory("cinba-update-throttle-", t);
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
  await prepareProductUpdate({ ...common, now: () => new Date("2026-09-18T01:00:00Z") });
  const reused = await prepareProductUpdate({
    ...common,
    now: () => new Date("2026-09-18T02:00:00Z"),
  });
  assert.equal(reused.phase, "current");
  assert.equal(discoveries, 1);
});

test("a rate-limited discovery records when the next automatic check may run", async (t) => {
  const root = temporaryDirectory("cinba-update-rate-limited-", t);
  const retryAfter = "2026-09-18T01:27:03.000Z";
  await assert.rejects(
    prepareProductUpdate({
      currentVersion: "0.1.0",
      currentRevision: "0".repeat(40),
      target: "windows-x64",
      stateDirectory: join(root, "state"),
      cacheDirectory: join(root, "cache"),
      now: () => new Date("2026-09-18T01:02:03Z"),
      discover: async () => {
        throw new UpdateRateLimitError("GitHub is rate limiting anonymous requests", retryAfter);
      },
    }),
    /GitHub is rate limiting anonymous requests/,
  );
  const saved = await readUpdateState(join(root, "state"));
  assert.equal(saved?.phase, "failed");
  assert.equal(saved?.failure, "discovery-failed");
  assert.equal(saved?.candidate, null);
  assert.equal(saved?.retryAfter, retryAfter);
  assert.equal(
    automaticUpdateCheckIsDue({
      state: saved,
      currentVersion: "0.1.0",
      now: new Date(Date.parse(retryAfter) - 1),
    }),
    false,
  );
  assert.equal(
    automaticUpdateCheckIsDue({
      state: saved,
      currentVersion: "0.1.0",
      now: new Date(retryAfter),
    }),
    true,
  );
});

test("a rate limit without a reset falls back to the ordinary daily check", async (t) => {
  const root = temporaryDirectory("cinba-update-rate-limited-open-", t);
  await assert.rejects(
    prepareProductUpdate({
      currentVersion: "0.1.0",
      currentRevision: "0".repeat(40),
      target: "windows-x64",
      stateDirectory: join(root, "state"),
      cacheDirectory: join(root, "cache"),
      now: () => new Date("2026-09-18T01:02:03Z"),
      discover: async () => {
        throw new UpdateRateLimitError("GitHub is rate limiting anonymous requests", null);
      },
    }),
    /GitHub is rate limiting anonymous requests/,
  );
  const saved = await readUpdateState(join(root, "state"));
  assert.equal(saved?.failure, "discovery-failed");
  assert.equal(saved?.retryAfter, undefined);
});
