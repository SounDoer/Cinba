import assert from "node:assert/strict";
import test from "node:test";
import { resolveSyncSettings } from "./runtime-view.ts";

test("first offline Sync startup explicitly falls back to Local Settings", () => {
  const result = resolveSyncSettings({
    sources: { settings: "sync", credentials: "sync" },
    local: {
      defaultModel: { provider: "local", id: "offline" },
      webTools: { searchPrimary: "brave" },
    },
    override: {},
  });
  assert.equal(result.source, "local-fallback");
  assert.equal(result.settings.defaultModel?.id, "offline");
});

test("an available Shared Settings Snapshot wins without changing override priority", () => {
  const result = resolveSyncSettings({
    sources: { settings: "sync", credentials: "local" },
    local: { defaultModel: undefined, webTools: { searchPrimary: "auto" } },
    shared: {
      defaultModel: { provider: "shared", id: "model" },
      webTools: { searchPrimary: "exa" },
    },
    override: { webTools: { searchPrimary: "brave" } },
  });
  assert.equal(result.source, "sync");
  assert.deepEqual(result.settings, {
    defaultModel: { provider: "shared", id: "model" },
    webTools: { searchPrimary: "brave" },
  });
});
