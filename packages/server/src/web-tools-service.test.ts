import assert from "node:assert/strict";
import test from "node:test";
import { createWebToolsService } from "./web-tools-service.ts";
import type { WebSearchPrimary } from "@cinba/contract";

test("status exposes credential metadata and the providers that will actually be tried", () => {
  const statuses = {
    exa: { configured: false, hasStoredCredential: false },
    brave: { configured: true, source: "stored" as const, hasStoredCredential: true },
  };
  let primary: WebSearchPrimary = "exa";
  const service = createWebToolsService({
    getPrimary: () => primary,
    setPrimary: (value) => {
      primary = value;
    },
    credentials: {
      getCredentialStatus: (provider) => statuses[provider],
      setApiKey: () => undefined,
      clearApiKey: () => undefined,
    },
  });

  const status = service.getStatus();

  assert.deepEqual(status, {
    primary: "exa",
    effectiveOrder: ["brave", "duckduckgo"],
    settingsSource: "local",
    credentialSource: "local",
    providers: [
      {
        id: "exa",
        name: "Exa",
        available: false,
        hasStoredCredential: false,
        bestEffort: false,
      },
      {
        id: "brave",
        name: "Brave Search",
        available: true,
        source: "stored",
        hasStoredCredential: true,
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
  });
  assert.equal(JSON.stringify(status).includes("apiKey"), false);
});

test("shared sources report effective credentials and refuse local mutations", () => {
  const service = createWebToolsService({
    getPrimary: () => "auto",
    setPrimary: () => assert.fail("must not write Local Settings"),
    getSources: () => ({ settings: "sync", credentials: "sync" }),
    credentials: {
      getCredentialStatus: (provider) => ({
        configured: provider === "exa",
        source: provider === "exa" ? "sync" : undefined,
        hasStoredCredential: false,
      }),
      setApiKey: () => assert.fail("must not write Local Credentials"),
      clearApiKey: () => assert.fail("must not write Local Credentials"),
    },
  });

  assert.deepEqual(service.getStatus().effectiveOrder, ["exa", "duckduckgo"]);
  assert.equal(service.getStatus().providers[0]?.source, "sync");
  assert.throws(() => service.configure("exa", "secret"), /managed by Sync/);
  assert.throws(() => service.remove("exa"), /managed by Sync/);
  assert.throws(() => service.choosePrimary("exa"), /managed by Sync/);
});

test("mutations use the credential store and immediately return fresh status", () => {
  const stored = new Set<"exa" | "brave">();
  let primary: WebSearchPrimary = "auto";
  const service = createWebToolsService({
    getPrimary: () => primary,
    setPrimary: (value) => {
      primary = value;
    },
    credentials: {
      getCredentialStatus: (provider) => ({
        configured: stored.has(provider),
        source: stored.has(provider) ? "stored" : undefined,
        hasStoredCredential: stored.has(provider),
      }),
      setApiKey: (provider) => {
        stored.add(provider);
      },
      clearApiKey: (provider) => {
        stored.delete(provider);
      },
    },
  });

  assert.deepEqual(service.configure("exa", "secret").effectiveOrder, ["exa", "duckduckgo"]);
  assert.equal(service.choosePrimary("brave").primary, "brave");
  assert.deepEqual(service.configure("brave", "other").effectiveOrder, [
    "brave",
    "exa",
    "duckduckgo",
  ]);
  assert.deepEqual(service.remove("brave").effectiveOrder, ["exa", "duckduckgo"]);
});
