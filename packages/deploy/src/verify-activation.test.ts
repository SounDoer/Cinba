import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyActivatedRelease } from "./verify-activation.ts";

const CURRENT = "1234567890abcdef1234567890abcdef12345678";
const TARGET = "abcdef1234567890abcdef1234567890abcdef12";
const BASE = {
  releasesRoot: "/home/cinba/releases",
  currentLink: "/home/cinba/current",
  targetRevision: TARGET,
  previousRevision: CURRENT,
  healthUrl: "http://127.0.0.1:4517/healthz",
  webSocketUrl: "ws://127.0.0.1:4517/ws",
};

function fakes(
  options: {
    startFailsAt?: number;
    healthFailsFor?: string;
    connectionFailsAt?: number;
  } = {},
) {
  const events: string[] = [];
  let starts = 0;
  let connections = 0;
  return {
    events,
    dependencies: {
      async startService() {
        starts += 1;
        events.push("start");
        if (starts === options.startFailsAt) {
          throw new Error("start failed");
        }
      },
      async stopService() {
        events.push("stop");
      },
      async switchRelease(input: { targetRevision: string; expectedCurrentRevision?: string }) {
        events.push(`switch:${input.expectedCurrentRevision}->${input.targetRevision}`);
      },
      async removeCurrent() {
        events.push("remove-current");
      },
      async waitForHealth(input: { expectedRevision: string }) {
        events.push(`health:${input.expectedRevision}`);
        if (input.expectedRevision === options.healthFailsFor) {
          throw new Error("health failed");
        }
      },
      async verifyConnection() {
        connections += 1;
        events.push("websocket");
        if (connections === options.connectionFailsAt) {
          throw new Error("connection failed");
        }
      },
      async refreshSync() {
        events.push("sync");
      },
    },
  };
}

test("a new core must pass both revision health and a WebSocket connection", async () => {
  const fake = fakes();
  assert.deepEqual(await verifyActivatedRelease(BASE, fake.dependencies), { kind: "succeeded" });
  assert.deepEqual(fake.events, ["start", `health:${TARGET}`, "websocket", "sync"]);
});

test("an unhealthy target is replaced by a verified previous release", async () => {
  const fake = fakes({ healthFailsFor: TARGET });
  const result = await verifyActivatedRelease(BASE, fake.dependencies);
  assert.equal(result.kind, "rolled_back");
  assert.equal(result.kind === "rolled_back" && result.failure, "health");
  assert.deepEqual(fake.events, [
    "start",
    `health:${TARGET}`,
    "stop",
    `switch:${TARGET}->${CURRENT}`,
    "start",
    `health:${CURRENT}`,
    "websocket",
    "sync",
  ]);
});

test("a target that cannot start is classified separately and rolled back", async () => {
  const fake = fakes({ startFailsAt: 1 });
  const result = await verifyActivatedRelease(BASE, fake.dependencies);
  assert.equal(result.kind === "rolled_back" && result.failure, "start");
  assert.deepEqual(fake.events, [
    "start",
    "stop",
    `switch:${TARGET}->${CURRENT}`,
    "start",
    `health:${CURRENT}`,
    "websocket",
    "sync",
  ]);
});

test("a failed first installation removes current but is not called a rollback", async () => {
  const fake = fakes({ connectionFailsAt: 1 });
  const result = await verifyActivatedRelease(
    { ...BASE, previousRevision: undefined },
    fake.dependencies,
  );
  assert.equal(result.kind === "failed" && result.failure, "health");
  assert.deepEqual(fake.events, [
    "start",
    `health:${TARGET}`,
    "websocket",
    "stop",
    "remove-current",
  ]);
});

test("a failed recovery is reported as a rollback failure", async () => {
  const fake = fakes({ healthFailsFor: CURRENT, connectionFailsAt: 1 });
  await assert.rejects(verifyActivatedRelease(BASE, fake.dependencies), (error: unknown) => {
    assert.equal(error instanceof AggregateError, true);
    assert.match((error as Error).message, /previous release could not be restored/);
    return true;
  });
});
