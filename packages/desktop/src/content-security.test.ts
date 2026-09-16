import assert from "node:assert/strict";
import test from "node:test";
import { remoteContentPreferences } from "./content-security.ts";

test("remote Core content is sandboxed without a preload", () => {
  const core = remoteContentPreferences();
  assert.equal("preload" in core, false);
  assert.equal(core.nodeIntegration, false);
  assert.equal(core.sandbox, true);
  assert.equal(core.partition, "persist:cinba-core");
});
