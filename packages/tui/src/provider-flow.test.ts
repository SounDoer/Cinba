import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { ProviderFlow } from "./provider-flow.ts";
import type { ProviderClient, ProviderFlowHost } from "./provider-flow.ts";

function setup(listResult = true) {
  const calls = {
    list: 0,
    set: [] as [string, string][],
    clear: [] as string[],
  };
  const client: ProviderClient = {
    listProviders: () => {
      calls.list += 1;
      return listResult;
    },
    setApiKey: (providerId, apiKey) => {
      calls.set.push([providerId, apiKey]);
      return true;
    },
    clearCredential: (providerId) => {
      calls.clear.push(providerId);
      return true;
    },
  };

  const output: string[] = [];
  const notices: string[] = [];
  let interaction: Component | undefined;
  let promptCount = 0;
  let renderCount = 0;
  const host: ProviderFlowHost = {
    append: (line) => output.push(line),
    showInteraction: (component) => {
      interaction = component;
    },
    showPrompt: () => {
      promptCount += 1;
    },
    requestRender: () => {
      renderCount += 1;
    },
    showNotice: (text) => notices.push(text),
  };

  return {
    calls,
    flow: new ProviderFlow(client, host),
    get interaction() {
      return interaction;
    },
    notices,
    output,
    get promptCount() {
      return promptCount;
    },
    get renderCount() {
      return renderCount;
    },
  };
}

function send(component: Component | undefined, data: string): void {
  assert.ok(component && "handleInput" in component);
  (component as Component & { handleInput(data: string): void }).handleInput(data);
}

test("lists configured providers for the /providers flow", () => {
  const state = setup();
  state.flow.list();
  state.flow.onListing([
    { id: "anthropic", name: "Anthropic", configured: true },
    { id: "groq", name: "Groq", configured: false },
  ]);

  assert.equal(state.calls.list, 1);
  assert.match(state.output.join("\n"), /Anthropic.*\(anthropic\)/);
  assert.match(state.output.join("\n"), /1 more available/);
  assert.equal(state.renderCount, 1);
});

test("login owns provider selection and secret collection", () => {
  const state = setup();
  state.flow.login();
  state.flow.onListing([{ id: "anthropic", name: "Anthropic", configured: false }]);

  assert.match(state.interaction?.render(80).join("\n") ?? "", /Give which provider an API key/);
  send(state.interaction, "\r");
  assert.equal(state.promptCount, 1);
  assert.match(state.interaction?.render(80).join("\n") ?? "", /API key for anthropic/);

  for (const character of "  secret-key  ") send(state.interaction, character);
  assert.doesNotMatch(state.interaction?.render(80).join("\n") ?? "", /secret-key/);
  send(state.interaction, "\r");

  assert.deepEqual(state.calls.set, [["anthropic", "secret-key"]]);
  assert.equal(state.promptCount, 2);
});

test("logout only offers configured providers", () => {
  const state = setup();
  state.flow.logout();
  state.flow.onListing([
    { id: "anthropic", name: "Anthropic", configured: false },
    { id: "groq", name: "Groq", configured: true },
  ]);

  const rendered = state.interaction?.render(80).join("\n") ?? "";
  assert.doesNotMatch(rendered, /Anthropic/);
  assert.match(rendered, /Groq/);
  send(state.interaction, "\r");

  assert.deepEqual(state.calls.clear, ["groq"]);
});

test("logout reports when no credentials are configured", () => {
  const state = setup();
  state.flow.logout();
  state.flow.onListing([{ id: "anthropic", name: "Anthropic", configured: false }]);

  assert.deepEqual(state.notices, ["nothing is configured"]);
  assert.equal(state.interaction, undefined);
});

test("a failed provider-list request does not consume a later unsolicited listing", () => {
  const state = setup(false);
  state.flow.login();
  state.flow.onListing([{ id: "anthropic", name: "Anthropic", configured: false }]);

  assert.equal(state.interaction, undefined);
});
