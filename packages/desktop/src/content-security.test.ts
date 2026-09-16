import assert from "node:assert/strict";
import test from "node:test";
import { remoteContentPreferences } from "./content-security.ts";

test("Sync cookies are isolated from Core content and neither remote view receives a preload", () => {
  const core = remoteContentPreferences("core");
  const sync = remoteContentPreferences("sync");
  assert.notEqual(core.partition, sync.partition);
  assert.equal("preload" in core, false);
  assert.equal("preload" in sync, false);
  assert.equal(sync.nodeIntegration, false);
  assert.equal(sync.sandbox, true);
});
