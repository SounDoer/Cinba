import assert from "node:assert/strict";
import test from "node:test";
import { createNavigationGuard } from "./navigation-guard.ts";

test("an old Core or Sync result cannot replace the newer selected page", () => {
  const guard = createNavigationGuard();
  const core = guard.begin();
  const sync = guard.begin();
  assert.equal(guard.current(core), false);
  assert.equal(guard.current(sync), true);
  const anotherCore = guard.begin();
  assert.equal(guard.current(sync), false);
  assert.equal(guard.current(anotherCore), true);
});
