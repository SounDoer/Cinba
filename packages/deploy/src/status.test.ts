import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeploymentStatus, stringifyDeploymentStatus } from "./status.ts";

const TARGET = "ABCDEF1234567890ABCDEF1234567890ABCDEF12";
const RUNNING = "1234567890abcdef1234567890abcdef12345678";
const UPDATED_AT = "2026-09-12T12:34:56.000Z";

test("a valid deployment status is normalized and serialized", () => {
  const parsed = parseDeploymentStatus({
    version: 1,
    phase: "verifying",
    updatedAt: UPDATED_AT,
    targetRevision: TARGET,
    runningRevision: RUNNING,
  });

  assert.deepEqual(parsed, {
    version: 1,
    phase: "verifying",
    updatedAt: UPDATED_AT,
    targetRevision: TARGET.toLowerCase(),
    runningRevision: RUNNING,
  });
  assert.equal(JSON.parse(stringifyDeploymentStatus(parsed!)).phase, "verifying");
});

test("idle is the only phase that needs no target revision", () => {
  assert.deepEqual(parseDeploymentStatus({ version: 1, phase: "idle", updatedAt: UPDATED_AT }), {
    version: 1,
    phase: "idle",
    updatedAt: UPDATED_AT,
  });
  assert.equal(
    parseDeploymentStatus({ version: 1, phase: "preparing", updatedAt: UPDATED_AT }),
    undefined,
  );
});

test("failures use bounded codes instead of leaking command output", () => {
  assert.deepEqual(
    parseDeploymentStatus({
      version: 1,
      phase: "rolled_back",
      updatedAt: UPDATED_AT,
      targetRevision: TARGET,
      failedRevision: TARGET,
      failure: "health",
    }),
    {
      version: 1,
      phase: "rolled_back",
      updatedAt: UPDATED_AT,
      targetRevision: TARGET.toLowerCase(),
      failedRevision: TARGET.toLowerCase(),
      failure: "health",
    },
  );
  assert.equal(
    parseDeploymentStatus({
      version: 1,
      phase: "failed",
      updatedAt: UPDATED_AT,
      targetRevision: TARGET,
      failure: "npm failed: token=secret",
    }),
    undefined,
  );
});

test("unknown fields and malformed values are rejected", () => {
  const base = {
    version: 1,
    phase: "succeeded",
    updatedAt: UPDATED_AT,
    targetRevision: TARGET,
  };
  assert.equal(parseDeploymentStatus({ ...base, output: "full command output" }), undefined);
  assert.equal(parseDeploymentStatus({ ...base, targetRevision: "main" }), undefined);
  assert.equal(parseDeploymentStatus({ ...base, updatedAt: "today" }), undefined);
  assert.equal(parseDeploymentStatus({ ...base, failure: "health" }), undefined);
});
