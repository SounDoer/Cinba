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

function send(component: Component | undefined, data: string): void {
  assert.ok(component && "handleInput" in component);
  (component as Component & { handleInput(data: string): void }).handleInput(data);
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

test("creating a Host explains Settings initialization and keeps Credentials local", async () => {
  let interaction: Component | undefined;
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
    {
      append: () => undefined,
      showInteraction: (component) => {
        interaction = component;
      },
      showPrompt: () => undefined,
      requestRender: () => undefined,
      showNotice: () => undefined,
    },
    {
      inspect: async () => ({ schemaVersion: 1, state: "not-created" }),
      create: async () => ({ status: { schemaVersion: 1, state: "not-created" } }),
    },
  );
  await flow.open();

  send(interaction, "\x1b[B");
  send(interaction, "\r");
  send(interaction, "\x1b[B");
  send(interaction, "\r");

  const rendered = interaction?.render(80).join("\n") ?? "";
  assert.match(rendered, /current Settings/i);
  assert.match(rendered, /Credentials stay/i);
  assert.match(rendered, /local/i);
});

test("a created Host shows its Setup Code and immediately offers VPS lifecycle choices", async () => {
  let interaction: Component | undefined;
  const output: string[] = [];
  const notices: string[] = [];
  const coreView = view("online");
  const created = {
    schemaVersion: 1 as const,
    state: "created" as const,
    publicOrigin: "https://sync.example.com",
    availability: "remote-https" as const,
    mode: "on-demand" as const,
    running: false,
    healthy: null,
    setupState: null,
    settingsRevision: null,
    syncRevision: null,
    connectedCoreCount: null,
    pendingEnrollmentCount: null,
  };
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
    {
      append: (line) => output.push(line),
      showInteraction: (component) => {
        interaction = component;
      },
      showPrompt: () => undefined,
      requestRender: () => undefined,
      showNotice: (text) => notices.push(text),
    },
    {
      inspect: async () => ({ schemaVersion: 1, state: "not-created" }),
      create: async () => ({ status: created, setupCode: "setup-once" }),
      setMode: async () => created,
    },
  );
  await flow.open();

  send(interaction, "\x1b[B");
  send(interaction, "\r");
  send(interaction, "\x1b[B");
  send(interaction, "\r");
  send(interaction, "\r");
  send(interaction, "https://sync.example.com");
  send(interaction, "\r");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(notices, ["Sync Host created"]);
  assert.match(output.join("\n"), /Setup Code: setup-once/);
  const rendered = interaction?.render(80).join("\n") ?? "";
  assert.match(rendered, /On-demand/);
  assert.match(rendered, /Background.*VPS/i);
});

test("configuring a Host warns that changing its origin can require reconnecting", async () => {
  let interaction: Component | undefined;
  const coreView = view("online");
  const created = {
    schemaVersion: 1 as const,
    state: "created" as const,
    publicOrigin: "https://sync.example.com",
    availability: "remote-https" as const,
    mode: "background" as const,
    running: true,
    healthy: true,
    setupState: "ready" as const,
    settingsRevision: 2,
    syncRevision: 4,
    connectedCoreCount: 1,
    pendingEnrollmentCount: 0,
  };
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
    {
      append: () => undefined,
      showInteraction: (component) => {
        interaction = component;
      },
      showPrompt: () => undefined,
      requestRender: () => undefined,
      showNotice: () => undefined,
    },
    {
      inspect: async () => created,
      configure: async () => created,
    },
  );
  await flow.open();

  send(interaction, "\x1b[B");
  send(interaction, "\r");
  assert.match(interaction?.render(80).join("\n") ?? "", /Configure public origin/);
  send(interaction, "\x1b[B");
  send(interaction, "\r");

  const rendered = interaction?.render(80).join("\n") ?? "";
  assert.match(rendered, /origin/i);
  assert.match(rendered, /reconnect/i);
});
