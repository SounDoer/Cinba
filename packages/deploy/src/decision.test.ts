import { test } from "node:test";
import assert from "node:assert/strict";
import { decideDeployment } from "./decision.ts";
import type { DeploymentStatus } from "./status.ts";

const CURRENT = "1234567890abcdef1234567890abcdef12345678";
const TARGET = "abcdef1234567890abcdef1234567890abcdef12";

function failedStatus(): DeploymentStatus {
  return {
    version: 1,
    phase: "rolled_back",
    updatedAt: "2026-09-12T12:34:56.000Z",
    targetRevision: TARGET,
    runningRevision: CURRENT,
    failedRevision: TARGET,
    failure: "health",
  };
}

test("the running revision needs no deployment", () => {
  assert.deepEqual(
    decideDeployment({
      targetRevision: CURRENT.toUpperCase(),
      runningRevision: CURRENT,
    }),
    { kind: "up_to_date", targetRevision: CURRENT },
  );
});

test("a failed target remains quarantined while prod is unchanged", () => {
  assert.deepEqual(
    decideDeployment({
      targetRevision: TARGET,
      runningRevision: CURRENT,
      previousStatus: failedStatus(),
    }),
    { kind: "quarantined", targetRevision: TARGET, failure: "health" },
  );
});

test("a new target is deployable after an earlier failure", () => {
  const next = "fedcba0987654321fedcba0987654321fedcba09";
  assert.deepEqual(
    decideDeployment({
      targetRevision: next,
      runningRevision: CURRENT,
      previousStatus: failedStatus(),
    }),
    { kind: "deploy", targetRevision: next },
  );
});

test("the first installation has no running revision and is deployable", () => {
  assert.deepEqual(decideDeployment({ targetRevision: TARGET }), {
    kind: "deploy",
    targetRevision: TARGET,
  });
});

test("untrusted command output must be a full Git revision", () => {
  assert.throws(() => decideDeployment({ targetRevision: "origin/prod" }), {
    message: "targetRevision is not a full Git revision",
  });
  assert.throws(() => decideDeployment({ targetRevision: TARGET, runningRevision: "HEAD" }), {
    message: "runningRevision is not a full Git revision",
  });
});
