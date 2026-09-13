import assert from "node:assert/strict";
import { test } from "node:test";
import { assessServiceIdle, readCoreLifetime } from "./service-idle.ts";

test("persistent is the default lifetime and never idles out", () => {
  assert.equal(readCoreLifetime(undefined), "persistent");
  assert.deepEqual(
    assessServiceIdle("persistent", { clientCount: 0, safeToStop: true, idleSince: 0 }, 100, 10),
    { idleSince: undefined, stop: false },
  );
});

test("only supported lifetime values are accepted", () => {
  assert.equal(readCoreLifetime("on-demand"), "on-demand");
  assert.throws(() => readCoreLifetime("temporary"), {
    message: "Unsupported CINBA_CORE_LIFETIME: temporary",
  });
});

test("the first client-free check starts the grace period", () => {
  assert.deepEqual(
    assessServiceIdle(
      "on-demand",
      { clientCount: 0, safeToStop: true, idleSince: undefined },
      100,
      10,
    ),
    { idleSince: 100, stop: false },
  );
});

test("a connected client clears the grace period", () => {
  assert.deepEqual(
    assessServiceIdle("on-demand", { clientCount: 1, safeToStop: true, idleSince: 100 }, 200, 10),
    { idleSince: undefined, stop: false },
  );
});

test("unsafe work keeps an expired on-demand Core alive", () => {
  assert.deepEqual(
    assessServiceIdle("on-demand", { clientCount: 0, safeToStop: false, idleSince: 100 }, 200, 10),
    { idleSince: 100, stop: false },
  );
});

test("a safe on-demand Core stops after the grace period", () => {
  assert.deepEqual(
    assessServiceIdle("on-demand", { clientCount: 0, safeToStop: true, idleSince: 100 }, 200, 10),
    { idleSince: 100, stop: true },
  );
});
