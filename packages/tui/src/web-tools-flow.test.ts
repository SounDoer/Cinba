import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import type { WebToolsStatus } from "@cinba/contract";
import { type WebToolsClient, WebToolsFlow, type WebToolsFlowHost } from "./web-tools-flow.ts";

const STATUS: WebToolsStatus = {
  primary: "auto",
  effectiveOrder: ["exa", "duckduckgo"],
  providers: [
    {
      id: "exa",
      name: "Exa",
      available: true,
      source: "stored",
      hasStoredCredential: true,
      bestEffort: false,
    },
    {
      id: "brave",
      name: "Brave Search",
      available: false,
      hasStoredCredential: false,
      bestEffort: false,
    },
    {
      id: "duckduckgo",
      name: "DuckDuckGo",
      available: true,
      hasStoredCredential: false,
      bestEffort: true,
    },
  ],
};

function setup(getResult = true) {
  const calls = {
    get: 0,
    set: [] as Array<[string, string]>,
    clear: [] as string[],
    primary: [] as string[],
  };
  const client: WebToolsClient = {
    getWebToolsStatus: () => {
      calls.get += 1;
      return getResult;
    },
    setWebToolsApiKey: (provider, key) => {
      calls.set.push([provider, key]);
      return true;
    },
    clearWebToolsApiKey: (provider) => {
      calls.clear.push(provider);
      return true;
    },
    setWebSearchPrimary: (primary) => {
      calls.primary.push(primary);
      return true;
    },
  };
  const output: string[] = [];
  const notices: string[] = [];
  let interaction: Component | undefined;
  const host: WebToolsFlowHost = {
    append: (line) => output.push(line),
    showInteraction: (component) => {
      interaction = component;
    },
    showPrompt: () => {
      interaction = undefined;
    },
    requestRender: () => undefined,
    showNotice: (text) => notices.push(text),
  };
  return {
    calls,
    flow: new WebToolsFlow(client, host),
    get interaction() {
      return interaction;
    },
    notices,
    output,
  };
}

function send(component: Component | undefined, data: string): void {
  assert.ok(component && "handleInput" in component);
  (component as Component & { handleInput(data: string): void }).handleInput(data);
}

test("opening requests fresh status and offers one interactive management menu", () => {
  const state = setup();
  state.flow.open();
  state.flow.onStatus(STATUS);

  assert.equal(state.calls.get, 1);
  const rendered = state.interaction?.render(80).join("\n") ?? "";
  assert.match(rendered, /Web tools/);
  assert.match(rendered, /View status/);
  assert.match(rendered, /Add or replace API key/);
  assert.match(rendered, /Remove stored API key/);
  assert.match(rendered, /Choose primary/);

  send(state.interaction, "\r");
  assert.match(state.output.join("\n"), /Primary: auto/);
  assert.match(state.output.join("\n"), /Effective order: Exa → DuckDuckGo/);
  assert.match(state.output.join("\n"), /Exa.*stored/);
  assert.match(state.output.join("\n"), /DuckDuckGo.*best-effort/);
});

test("adding a key uses masked input and waits for a fresh status reply", () => {
  const state = setup();
  state.flow.open();
  state.flow.onStatus(STATUS);

  send(state.interaction, "\x1b[B");
  send(state.interaction, "\r");
  send(state.interaction, "\r");
  for (const character of "new-secret") {
    send(state.interaction, character);
  }
  assert.doesNotMatch(state.interaction?.render(80).join("\n") ?? "", /new-secret/);
  send(state.interaction, "\r");

  assert.deepEqual(state.calls.set, [["exa", "new-secret"]]);
  state.flow.onStatus(STATUS);
  assert.deepEqual(state.notices, ["Web tools settings updated"]);
});

test("a server error is shown without retaining or printing the submitted key", () => {
  const state = setup();
  state.flow.open();
  state.flow.onStatus(STATUS);
  send(state.interaction, "\x1b[B");
  send(state.interaction, "\r");
  send(state.interaction, "\r");
  send(state.interaction, "secret");
  send(state.interaction, "\r");

  state.flow.onStatus(STATUS, "Could not access web tools settings");

  assert.deepEqual(state.notices, ["Could not access web tools settings"]);
  assert.doesNotMatch(state.output.join("\n"), /secret/);
});
