import { test } from "node:test";
import assert from "node:assert/strict";
import { type DrainStopMode, canProcessDuringDrain, createDrainController } from "./drain.ts";

test("draining accepts only aborts and answers to existing confirmations", () => {
  assert.equal(canProcessDuringDrain("abort"), true);
  assert.equal(canProcessDuringDrain("respond_confirm"), true);
  for (const type of ["prompt", "edit_message", "set_model", "create_session", "set_api_key"]) {
    assert.equal(canProcessDuringDrain(type), false, type);
  }
});

test("an already safe core stops normally as soon as draining starts", async () => {
  const modes: DrainStopMode[] = [];
  const drain = createDrainController({
    isSafe: () => true,
    stop: (mode) => {
      modes.push(mode);
    },
  });

  drain.request();
  await drain.wait();

  assert.equal(drain.draining, true);
  assert.deepEqual(modes, ["safe"]);
});

test("an active core waits until a later safety check succeeds", async () => {
  let safe = false;
  const modes: DrainStopMode[] = [];
  const drain = createDrainController({
    isSafe: () => safe,
    stop: (mode) => {
      modes.push(mode);
    },
  });

  drain.request();
  assert.deepEqual(modes, []);
  safe = true;
  drain.check();
  await drain.wait();

  assert.deepEqual(modes, ["safe"]);
});

test("the deadline forces an orderly stop when work does not settle", async () => {
  const modes: DrainStopMode[] = [];
  const drain = createDrainController({
    isSafe: () => false,
    stop: (mode) => {
      modes.push(mode);
    },
    timeoutMs: 10,
  });

  drain.request();
  await drain.wait();

  assert.deepEqual(modes, ["forced"]);
});

test("a second stop request forces draining without running cleanup twice", async () => {
  const modes: DrainStopMode[] = [];
  const drain = createDrainController({
    isSafe: () => false,
    stop: (mode) => {
      modes.push(mode);
    },
  });

  drain.request();
  drain.force();
  drain.force();
  await drain.wait();

  assert.deepEqual(modes, ["forced"]);
});
