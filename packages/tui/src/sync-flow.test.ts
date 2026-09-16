import assert from "node:assert/strict";
import test from "node:test";
import type { CoreSyncState, CoreSyncView } from "@cinba/contract";
import { describeCoreSync } from "./sync-flow.ts";

function view(state: CoreSyncState): CoreSyncView {
  return {
    version: 1,
    state,
    sources:
      state === "disconnected"
        ? { settings: "local", credentials: "local" }
        : { settings: "sync", credentials: "local" },
    effectiveSettingsSource: state === "stale" || state === "online" ? "sync" : "local-fallback",
    ...(state === "stale" ? { errorCode: "offline" as const, action: "retry" as const } : {}),
    ...(state === "revoked" ? { errorCode: "revoked" as const, action: "reconnect" as const } : {}),
    override: {},
    effective: { webTools: { searchPrimary: "auto" } },
  };
}

test("Local, pending, online, stale, and revoked states remain explicit", () => {
  for (const state of ["disconnected", "pending", "online", "stale", "revoked"] as const) {
    assert.match(describeCoreSync(view(state)).join("\n"), new RegExp(`Sync ${state}`));
  }
  assert.match(describeCoreSync(view("stale")).join("\n"), /Last error: offline/);
  assert.match(describeCoreSync(view("revoked")).join("\n"), /Last error: revoked/);
});

test("effective values identify base versus Core override", () => {
  const overridden: CoreSyncView = {
    ...view("online"),
    shared: {
      defaultModel: { provider: "anthropic", id: "shared" },
      webTools: { searchPrimary: "exa" },
    },
    override: {
      defaultModel: { provider: "openai", id: "local" },
      webTools: { searchPrimary: "brave" },
    },
    effective: {
      defaultModel: { provider: "openai", id: "local" },
      webTools: { searchPrimary: "brave" },
    },
  };
  const output = describeCoreSync(overridden).join("\n");
  assert.match(output, /openai\/local \(Core override\)/);
  assert.match(output, /brave \(Core override\)/);
  assert.doesNotMatch(output, /password|api key|credential value/i);
});
