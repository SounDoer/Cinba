import { test } from "node:test";
import assert from "node:assert/strict";
import { assessIdle, canStopNow, IDLE_TIMEOUT_MS } from "./reclaim.ts";

const IDLE = {
  hasViewers: false,
  busy: false,
  awaitingConfirmation: false,
  idleSince: undefined,
};

test("a watched conversation is never reclaimed, and its clock is cleared", () => {
  const verdict = assessIdle({ ...IDLE, hasViewers: true, idleSince: 0 }, 999_999_999);
  assert.equal(verdict.reclaim, false);
  assert.equal(verdict.idleSince, undefined);
});

test("the clock starts the first time nobody is watching", () => {
  const verdict = assessIdle(IDLE, 1000);
  assert.equal(verdict.idleSince, 1000);
  assert.equal(verdict.reclaim, false);
});

test("it is reclaimed once the quiet period has passed", () => {
  const before = assessIdle({ ...IDLE, idleSince: 1000 }, 1000 + IDLE_TIMEOUT_MS - 1);
  assert.equal(before.reclaim, false);

  const after = assessIdle({ ...IDLE, idleSince: 1000 }, 1000 + IDLE_TIMEOUT_MS);
  assert.equal(after.reclaim, true);
});

test("a conversation mid-answer is not idle, however long nobody has watched", () => {
  // Its viewer may have closed the tab while it works; stopping it would
  // abandon a turn that is still running.
  const verdict = assessIdle({ ...IDLE, busy: true, idleSince: 0 }, 999_999_999);
  assert.equal(verdict.reclaim, false);
  assert.equal(verdict.idleSince, undefined, "and the quiet period starts over afterwards");
});

test("a conversation waiting on allow or deny is not idle either", () => {
  // Pi is blocked inside the permission gate. The person may have stepped away
  // mid-decision, and killing it would drop the answer they were about to give.
  const verdict = assessIdle({ ...IDLE, awaitingConfirmation: true, idleSince: 0 }, 999_999_999);
  assert.equal(verdict.reclaim, false);
  assert.equal(verdict.idleSince, undefined);
});

test("finishing a turn gives it the whole quiet period again", () => {
  const wasBusy = assessIdle({ ...IDLE, busy: true, idleSince: 500 }, 1000);
  assert.equal(wasBusy.idleSince, undefined);

  const nowIdle = assessIdle({ ...IDLE, idleSince: wasBusy.idleSince }, 1000);
  assert.equal(nowIdle.idleSince, 1000, "the clock restarts, rather than resuming from 500");
});

test("a quiet conversation can be stopped on demand", () => {
  // Nobody is mid-anything, so the process can go now rather than at the end of
  // a quiet period. Watchers are not consulted: reopening is transparent to them.
  assert.equal(canStopNow({ busy: false, awaitingConfirmation: false }), true);
});

test("a conversation mid-answer or mid-decision cannot be stopped on demand", () => {
  assert.equal(canStopNow({ busy: true, awaitingConfirmation: false }), false);
  assert.equal(canStopNow({ busy: false, awaitingConfirmation: true }), false);
});
