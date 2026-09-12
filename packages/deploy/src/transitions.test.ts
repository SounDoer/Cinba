import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceDeployment, beginDeployment } from "./transitions.ts";

const CURRENT = "1234567890abcdef1234567890abcdef12345678";
const TARGET = "abcdef1234567890abcdef1234567890abcdef12";
const OLD_FAILURE = "fedcba0987654321fedcba0987654321fedcba09";

function at(second: number): Date {
  return new Date(`2026-09-12T12:34:${String(second).padStart(2, "0")}.000Z`);
}

test("a deployment starts with the rollback revision protected", () => {
  assert.deepEqual(
    beginDeployment({
      targetRevision: TARGET.toUpperCase(),
      runningRevision: CURRENT,
      previousStatus: {
        version: 1,
        phase: "failed",
        updatedAt: at(0).toISOString(),
        targetRevision: OLD_FAILURE,
        failedRevision: OLD_FAILURE,
        failure: "checks",
      },
      now: at(1),
    }),
    {
      version: 1,
      phase: "preparing",
      updatedAt: at(1).toISOString(),
      targetRevision: TARGET,
      runningRevision: CURRENT,
      failedRevision: OLD_FAILURE,
    },
  );
});

test("the successful path advances in order and promotes the target", () => {
  let status = beginDeployment({ targetRevision: TARGET, runningRevision: CURRENT, now: at(1) });
  for (const [phase, second] of [
    ["checking", 2],
    ["waiting_for_drain", 3],
    ["switching", 4],
    ["verifying", 5],
    ["succeeded", 6],
  ] as const) {
    status = advanceDeployment(status, phase, { now: at(second) });
  }

  assert.equal(status.runningRevision, TARGET);
  assert.equal(status.previousRevision, CURRENT);
  assert.equal(status.failedRevision, undefined);
  assert.equal(status.failure, undefined);
});

test("a failure records the target revision for quarantine", () => {
  const preparing = beginDeployment({
    targetRevision: TARGET,
    runningRevision: CURRENT,
    now: at(1),
  });
  const failed = advanceDeployment(preparing, "failed", {
    failure: "install",
    now: at(2),
  });

  assert.equal(failed.phase, "failed");
  assert.equal(failed.runningRevision, CURRENT);
  assert.equal(failed.failedRevision, TARGET);
  assert.equal(failed.failure, "install");
});

test("a failed verification records a successful rollback", () => {
  let status = beginDeployment({ targetRevision: TARGET, runningRevision: CURRENT, now: at(1) });
  for (const phase of ["checking", "waiting_for_drain", "switching", "verifying"] as const) {
    status = advanceDeployment(status, phase, { now: at(2) });
  }
  status = advanceDeployment(status, "rolled_back", { failure: "health", now: at(3) });

  assert.equal(status.runningRevision, CURRENT);
  assert.equal(status.failedRevision, TARGET);
  assert.equal(status.failure, "health");
});

test("invalid jumps and misplaced failure codes are refused", () => {
  const preparing = beginDeployment({ targetRevision: TARGET, now: at(1) });
  assert.throws(() => advanceDeployment(preparing, "succeeded"), {
    message: "Invalid deployment transition: preparing -> succeeded",
  });
  assert.throws(() => advanceDeployment(preparing, "failed"), {
    message: "A failed deployment needs a failure code",
  });
  assert.throws(() => advanceDeployment(preparing, "checking", { failure: "checks" }), {
    message: "Failure code is only valid at failure",
  });
});

test("a rollback failure does not claim that either release is running", () => {
  let status = beginDeployment({ targetRevision: TARGET, runningRevision: CURRENT, now: at(1) });
  for (const phase of ["checking", "waiting_for_drain", "switching", "verifying"] as const) {
    status = advanceDeployment(status, phase, { now: at(2) });
  }
  status = advanceDeployment(status, "failed", { failure: "rollback", now: at(3) });

  assert.equal(status.runningRevision, undefined);
  assert.equal(status.previousRevision, undefined);
  assert.equal(status.failedRevision, TARGET);
});

test("a failed candidate does not erase the older successful fallback", () => {
  const older = OLD_FAILURE;
  let status = beginDeployment({
    targetRevision: TARGET,
    runningRevision: CURRENT,
    previousStatus: {
      version: 1,
      phase: "succeeded",
      updatedAt: at(0).toISOString(),
      targetRevision: CURRENT,
      runningRevision: CURRENT,
      previousRevision: older,
    },
    now: at(1),
  });
  assert.equal(status.previousRevision, older);
  for (const phase of ["checking", "waiting_for_drain", "switching", "verifying"] as const) {
    status = advanceDeployment(status, phase, { now: at(2) });
  }
  status = advanceDeployment(status, "rolled_back", { failure: "health", now: at(3) });

  assert.equal(status.runningRevision, CURRENT);
  assert.equal(status.previousRevision, older);
});
