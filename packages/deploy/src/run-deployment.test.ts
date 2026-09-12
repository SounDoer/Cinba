import { test } from "node:test";
import assert from "node:assert/strict";
import { ReleaseActivationError } from "./activate-release.ts";
import { ReleasePreparationError } from "./prepare-release.ts";
import { runDeployment } from "./run-deployment.ts";
import type { DeploymentStatus } from "./status.ts";

const CURRENT = "1234567890abcdef1234567890abcdef12345678";
const TARGET = "abcdef1234567890abcdef1234567890abcdef12";
const OPTIONS = {
  repoPath: "/home/cinba/Cinba",
  releasesRoot: "/home/cinba/releases",
  currentLink: "/home/cinba/current",
  statusPath: "/home/cinba/.cinba/deployment.json",
  healthUrl: "http://127.0.0.1:4517/healthz",
  webSocketUrl: "ws://127.0.0.1:4517/ws",
};

function previous(overrides: Partial<DeploymentStatus> = {}): DeploymentStatus {
  return {
    version: 1,
    phase: "succeeded",
    updatedAt: "2026-09-12T00:00:00.000Z",
    targetRevision: CURRENT,
    runningRevision: CURRENT,
    previousRevision: CURRENT,
    ...overrides,
  };
}

function fakes(overrides: Record<string, unknown> = {}) {
  const statuses: DeploymentStatus[] = [];
  const events: string[] = [];
  let tick = 0;
  const dependencies = {
    async readStatus() {
      return previous();
    },
    async writeStatus(_path: string, status: DeploymentStatus) {
      statuses.push(status);
    },
    async fetchTarget() {
      events.push("fetch");
      return TARGET;
    },
    async checkFastForward() {
      events.push("fast-forward");
      return true;
    },
    async prepare(options: { onChecking?: () => Promise<void> }) {
      events.push("prepare");
      await options.onChecking?.();
      return { path: `${OPTIONS.releasesRoot}/${TARGET}`, revision: TARGET };
    },
    async activate() {
      events.push("activate");
    },
    async verifyActivation() {
      events.push("verify");
      return { kind: "succeeded" as const };
    },
    async startService() {
      events.push("restore-start");
    },
    async waitForHealth(input: { expectedRevision: string }) {
      events.push(`restore-health:${input.expectedRevision}`);
    },
    async verifyConnection() {
      events.push("restore-websocket");
    },
    now() {
      tick += 1;
      return new Date(`2026-09-12T00:00:${String(tick).padStart(2, "0")}.000Z`);
    },
    ...overrides,
  };
  return { dependencies, statuses, events };
}

test("one deployment records every durable phase in order", async () => {
  const fake = fakes();
  assert.deepEqual(await runDeployment(OPTIONS, fake.dependencies), {
    kind: "succeeded",
    targetRevision: TARGET,
  });
  assert.deepEqual(
    fake.statuses.map((status) => status.phase),
    ["preparing", "checking", "waiting_for_drain", "switching", "verifying", "succeeded"],
  );
  assert.deepEqual(fake.events, ["fetch", "fast-forward", "prepare", "activate", "verify"]);
  assert.equal(fake.statuses.at(-1)?.runningRevision, TARGET);
});

test("an unchanged or quarantined prod exits before preparing anything", async () => {
  const unchanged = fakes({
    async fetchTarget() {
      return CURRENT;
    },
  });
  assert.equal((await runDeployment(OPTIONS, unchanged.dependencies)).kind, "up_to_date");
  assert.deepEqual(unchanged.statuses, []);

  const quarantined = fakes({
    async readStatus() {
      return previous({ phase: "failed", failedRevision: TARGET, failure: "health" });
    },
  });
  assert.deepEqual(await runDeployment(OPTIONS, quarantined.dependencies), {
    kind: "quarantined",
    targetRevision: TARGET,
    failure: "health",
  });
  assert.deepEqual(quarantined.statuses, []);
});

test("preparation failures record their bounded stage and quarantine the target", async () => {
  const cause = new ReleasePreparationError("install", new Error("npm details"));
  const fake = fakes({
    async prepare() {
      throw cause;
    },
  });
  const result = await runDeployment(OPTIONS, fake.dependencies);
  assert.equal(result.kind === "failed" && result.failure, "install");
  assert.deepEqual(
    fake.statuses.map((status) => status.phase),
    ["preparing", "failed"],
  );
  assert.equal(fake.statuses.at(-1)?.failedRevision, TARGET);
});

test("a Git ancestry check error is recorded without preparing a release", async () => {
  const fake = fakes({
    async checkFastForward() {
      throw new Error("git details");
    },
  });
  const result = await runDeployment(OPTIONS, fake.dependencies);
  assert.equal(result.kind === "failed" && result.failure, "checks");
  assert.deepEqual(
    fake.statuses.map((status) => status.phase),
    ["preparing", "failed"],
  );
  assert.equal(fake.events.includes("prepare"), false);
});

test("a verified rollback is recorded without promoting the failed target", async () => {
  const cause = new Error("new core unhealthy");
  const fake = fakes({
    async verifyActivation() {
      return { kind: "rolled_back" as const, failure: "health" as const, cause };
    },
  });
  const result = await runDeployment(OPTIONS, fake.dependencies);
  assert.equal(result.kind, "rolled_back");
  assert.equal(fake.statuses.at(-1)?.phase, "rolled_back");
  assert.equal(fake.statuses.at(-1)?.runningRevision, CURRENT);
  assert.equal(fake.statuses.at(-1)?.failedRevision, TARGET);
});

test("a failed switch restarts and verifies the unchanged old release", async () => {
  const fake = fakes({
    async activate() {
      throw new ReleaseActivationError("switch", new Error("rename details"));
    },
  });
  const result = await runDeployment(OPTIONS, fake.dependencies);
  assert.equal(result.kind === "failed" && result.failure, "switch");
  assert.deepEqual(fake.events.slice(-3), [
    "restore-start",
    `restore-health:${CURRENT}`,
    "restore-websocket",
  ]);
  assert.equal(fake.statuses.at(-1)?.phase, "failed");
});

test("fetch failures do not invent an unknown target in durable status", async () => {
  const fake = fakes({
    async fetchTarget() {
      throw new Error("network details");
    },
  });
  const result = await runDeployment(OPTIONS, fake.dependencies);
  assert.equal(result.kind === "failed" && result.failure, "fetch");
  assert.deepEqual(fake.statuses, []);
});

test("an interrupted durable phase is preserved for explicit recovery", async () => {
  const interrupted = previous({ phase: "switching", targetRevision: TARGET });
  const fake = fakes({
    async readStatus() {
      return interrupted;
    },
  });
  assert.deepEqual(await runDeployment(OPTIONS, fake.dependencies), {
    kind: "recovery_required",
    status: interrupted,
  });
  assert.deepEqual(fake.events, []);
  assert.deepEqual(fake.statuses, []);
});
