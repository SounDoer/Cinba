import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverInterruptedDeployment } from "./recover-deployment.ts";
import type { DeploymentStatus } from "./status.ts";

const CURRENT = "1234567890abcdef1234567890abcdef12345678";
const TARGET = "abcdef1234567890abcdef1234567890abcdef12";
const OTHER = "fedcba0987654321fedcba0987654321fedcba09";
const OPTIONS = {
  repoPath: "/home/cinba/Cinba",
  releasesRoot: "/home/cinba/releases",
  currentLink: "/home/cinba/current",
  statusPath: "/home/cinba/.cinba/deployment.json",
  healthUrl: "http://127.0.0.1:4517/healthz",
  webSocketUrl: "ws://127.0.0.1:4517/ws",
};

function interrupted(phase: DeploymentStatus["phase"]): DeploymentStatus {
  return {
    version: 1,
    phase,
    updatedAt: "2026-09-12T00:00:00.000Z",
    targetRevision: TARGET,
    runningRevision: CURRENT,
    previousRevision: CURRENT,
  };
}

function fakes(actualRevision: string | undefined) {
  const statuses: DeploymentStatus[] = [];
  const events: string[] = [];
  return {
    statuses,
    events,
    dependencies: {
      async readCurrent() {
        return actualRevision;
      },
      async writeStatus(_path: string, status: DeploymentStatus) {
        statuses.push(status);
      },
      async discard() {
        events.push("discard");
      },
      async startService() {
        events.push("start");
      },
      async waitForHealth(input: { expectedRevision: string }) {
        events.push(`health:${input.expectedRevision}`);
      },
      async verifyConnection() {
        events.push("websocket");
      },
      async verifyActivation() {
        events.push("verify-target");
        return { kind: "succeeded" as const };
      },
      now() {
        return new Date("2026-09-12T00:00:01.000Z");
      },
    },
  };
}

test("an interrupted check discards only its unfinished target and quarantines it", async () => {
  const fake = fakes(CURRENT);
  const result = await recoverInterruptedDeployment(
    OPTIONS,
    interrupted("checking"),
    fake.dependencies,
  );
  assert.equal(result.kind === "failed" && result.failure, "checks");
  assert.deepEqual(fake.events, ["discard"]);
  assert.equal(fake.statuses.at(-1)?.failedRevision, TARGET);
  assert.equal(fake.statuses.at(-1)?.runningRevision, CURRENT);
});

test("a target already selected at the crash is resumed from verification", async () => {
  const fake = fakes(TARGET);
  const result = await recoverInterruptedDeployment(
    OPTIONS,
    interrupted("switching"),
    fake.dependencies,
  );
  assert.equal(result.kind, "succeeded");
  assert.deepEqual(
    fake.statuses.map((status) => status.phase),
    ["verifying", "succeeded"],
  );
  assert.deepEqual(fake.events, ["verify-target"]);
  assert.equal(fake.statuses.at(-1)?.runningRevision, TARGET);
});

test("a crash before the switch verifies the old core and abandons the target", async () => {
  const fake = fakes(CURRENT);
  const result = await recoverInterruptedDeployment(
    OPTIONS,
    interrupted("switching"),
    fake.dependencies,
  );
  assert.equal(result.kind === "failed" && result.failure, "switch");
  assert.deepEqual(fake.events, ["start", `health:${CURRENT}`, "websocket", "discard"]);
});

test("a completed rollback interrupted before its status write is recognized", async () => {
  const fake = fakes(CURRENT);
  const result = await recoverInterruptedDeployment(
    OPTIONS,
    interrupted("verifying"),
    fake.dependencies,
  );
  assert.equal(result.kind === "rolled_back" && result.failure, "health");
  assert.deepEqual(fake.events, ["start", `health:${CURRENT}`, "websocket", "discard"]);
  assert.equal(fake.statuses.at(-1)?.phase, "rolled_back");
});

test("an unexpected current release fails closed and clears the running claim", async () => {
  const fake = fakes(OTHER);
  const result = await recoverInterruptedDeployment(
    OPTIONS,
    interrupted("verifying"),
    fake.dependencies,
  );
  assert.equal(result.kind === "failed" && result.failure, "rollback");
  assert.equal(fake.statuses.at(-1)?.runningRevision, undefined);
  assert.deepEqual(fake.events, []);
});
