import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import type { CoreSyncState, CoreSyncView } from "@cinba/contract";
import { SyncFlow, type SyncFlowHost, describeCoreSync } from "./sync-flow.ts";

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

test("opening Sync separates This Core from the local Sync Host", async () => {
  let interaction: Component | undefined;
  const host: SyncFlowHost = {
    append: () => undefined,
    showInteraction: (component) => {
      interaction = component;
    },
    showPrompt: () => undefined,
    requestRender: () => undefined,
    showNotice: () => undefined,
  };
  const coreView = view("disconnected");
  const flow = new SyncFlow(
    {
      status: async () => coreView,
      cancelEnrollment: async () => ({ version: 1, accepted: true }),
      syncNow: async () => ({ version: 1, accepted: true }),
      updateSources: async () => ({ version: 1, accepted: true }),
      disconnect: async () => ({ version: 1, accepted: true }),
      connect: async () => ({ version: 1, accepted: true }),
      updateOverride: async () => ({ version: 1, accepted: true }),
    },
    host,
    { inspect: async () => ({ schemaVersion: 1, state: "not-created" }) },
  );

  await flow.open();

  const rendered = interaction?.render(80).join("\n") ?? "";
  assert.match(rendered, /Cinba Sync/);
  assert.match(rendered, /This Core/);
  assert.match(rendered, /Sync Host on this device.*not created/);
});
