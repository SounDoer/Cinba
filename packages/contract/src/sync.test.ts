import assert from "node:assert/strict";
import test from "node:test";
import {
  CORE_SYNC_ROUTES,
  parseConnectCoreSyncRequest,
  parseCoreSyncView,
  parseUpdateCoreInstanceOverrideRequest,
} from "./sync.ts";

test("the current Core contract has no administrator credential mutation route", () => {
  assert.equal(
    Object.keys(CORE_SYNC_ROUTES).some((name) => /credential|password/i.test(name)),
    false,
  );
});

test("parses the current Core Sync view without exposing credentials", () => {
  const view = parseCoreSyncView({
    version: 1,
    state: "online",
    sources: { settings: "sync", credentials: "local" },
    effectiveSettingsSource: "sync",
    serverUrl: "https://sync.example.test",
    managementUrl: "https://sync.example.test/",
    syncRevision: 7,
    settingsRevision: 4,
    shared: {
      defaultModel: { provider: "anthropic", id: "claude-sonnet-4" },
      webTools: { searchPrimary: "exa" },
    },
    override: { webTools: { searchPrimary: "brave" } },
    effective: {
      defaultModel: { provider: "anthropic", id: "claude-sonnet-4" },
      webTools: { searchPrimary: "brave" },
    },
  });

  assert.equal(view.state, "online");
  assert.equal(view.effective.webTools.searchPrimary, "brave");
  assert.equal("credential" in view, false);
});

test("rejects unsupported source combinations", () => {
  assert.throws(
    () =>
      parseConnectCoreSyncRequest({
        version: 1,
        serverUrl: "https://sync.example.test",
        sources: { settings: "local", credentials: "sync" },
      }),
    /Local Settings cannot use Shared Credentials/,
  );
});

test("parses an empty override as Reset to shared", () => {
  assert.deepEqual(parseUpdateCoreInstanceOverrideRequest({ version: 1, override: {} }), {
    version: 1,
    override: {},
  });
});

test("rejects unknown fields and malformed status values", () => {
  assert.throws(() =>
    parseUpdateCoreInstanceOverrideRequest({ version: 1, override: {}, apiKey: "secret" }),
  );
  assert.throws(() =>
    parseCoreSyncView({
      version: 1,
      state: "connected",
      sources: { settings: "local", credentials: "local" },
      effectiveSettingsSource: "local",
      override: {},
      effective: { webTools: { searchPrimary: "auto" } },
    }),
  );
});
