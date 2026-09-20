import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import { createWebToolsCredentialStore } from "./credentials.ts";

test("a missing credentials file reports both paid providers as unconfigured", (t) => {
  const root = temporaryDirectory("cinba-web-tools-credentials-", t);
  const store = createWebToolsCredentialStore(join(root, "credentials.json"), {});

  assert.deepEqual(store.getCredentialStatus("exa"), {
    configured: false,
    hasStoredCredential: false,
  });
  assert.deepEqual(store.getCredentialStatus("brave"), {
    configured: false,
    hasStoredCredential: false,
  });
});

test("an environment credential is reported without exposing its value", (t) => {
  const root = temporaryDirectory("cinba-web-tools-credentials-", t);
  const store = createWebToolsCredentialStore(join(root, "credentials.json"), {
    EXA_API_KEY: "environment-exa-key",
  });

  assert.deepEqual(store.getCredentialStatus("exa"), {
    configured: true,
    source: "environment",
    hasStoredCredential: false,
  });
  assert.equal(
    JSON.stringify(store.getCredentialStatus("exa")).includes("environment-exa-key"),
    false,
  );
});

test("a stored credential is reported without exposing its value", (t) => {
  const root = temporaryDirectory("cinba-web-tools-credentials-", t);
  const path = join(root, "credentials.json");
  writeFileSync(
    path,
    JSON.stringify({ webTools: { brave: { apiKey: "stored-brave-key" } } }),
    "utf8",
  );
  const store = createWebToolsCredentialStore(path, {});

  const status = store.getCredentialStatus("brave");
  assert.deepEqual(status, {
    configured: true,
    source: "stored",
    hasStoredCredential: true,
  });
  assert.equal(JSON.stringify(status).includes("stored-brave-key"), false);
});

test("an environment credential takes precedence over a stored credential", (t) => {
  const root = temporaryDirectory("cinba-web-tools-credentials-", t);
  const path = join(root, "credentials.json");
  writeFileSync(path, JSON.stringify({ webTools: { exa: { apiKey: "stored-exa-key" } } }), "utf8");
  const store = createWebToolsCredentialStore(path, { EXA_API_KEY: "environment-exa-key" });

  assert.equal(store.getApiKey("exa"), "environment-exa-key");
  assert.deepEqual(store.getCredentialStatus("exa"), {
    configured: true,
    source: "environment",
    hasStoredCredential: true,
  });
});

test("setting a credential makes it available to tools and redacted status", (t) => {
  const root = temporaryDirectory("cinba-web-tools-credentials-", t);
  const store = createWebToolsCredentialStore(join(root, "credentials.json"), {});

  store.setApiKey("exa", "stored-exa-key");

  assert.equal(store.getApiKey("exa"), "stored-exa-key");
  assert.deepEqual(store.getCredentialStatus("exa"), {
    configured: true,
    source: "stored",
    hasStoredCredential: true,
  });
});

test("setting one provider preserves another provider's credential", (t) => {
  const root = temporaryDirectory("cinba-web-tools-credentials-", t);
  const path = join(root, "credentials.json");
  writeFileSync(
    path,
    JSON.stringify({ webTools: { brave: { apiKey: "stored-brave-key" } } }),
    "utf8",
  );
  const store = createWebToolsCredentialStore(path, {});

  store.setApiKey("exa", "stored-exa-key");

  const reloaded = createWebToolsCredentialStore(path, {});
  assert.equal(reloaded.getApiKey("exa"), "stored-exa-key");
  assert.equal(reloaded.getApiKey("brave"), "stored-brave-key");
});

test("setting a web tools credential preserves other credential namespaces", (t) => {
  const root = temporaryDirectory("cinba-web-tools-credentials-", t);
  const path = join(root, "credentials.json");
  writeFileSync(path, JSON.stringify({ futureExtension: { token: "keep-me" } }), "utf8");
  const store = createWebToolsCredentialStore(path, {});

  store.setApiKey("exa", "stored-exa-key");

  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).futureExtension, {
    token: "keep-me",
  });
});

test("clearing removes only the selected stored credential", (t) => {
  const root = temporaryDirectory("cinba-web-tools-credentials-", t);
  const path = join(root, "credentials.json");
  writeFileSync(
    path,
    JSON.stringify({
      webTools: {
        exa: { apiKey: "stored-exa-key" },
        brave: { apiKey: "stored-brave-key" },
      },
    }),
    "utf8",
  );
  const store = createWebToolsCredentialStore(path, { EXA_API_KEY: "environment-exa-key" });

  store.clearApiKey("exa");

  assert.equal(store.getApiKey("exa"), "environment-exa-key");
  assert.deepEqual(store.getCredentialStatus("exa"), {
    configured: true,
    source: "environment",
    hasStoredCredential: false,
  });
  assert.equal(store.getApiKey("brave"), "stored-brave-key");
});

test("setting an empty credential is rejected", (t) => {
  const root = temporaryDirectory("cinba-web-tools-credentials-", t);
  const store = createWebToolsCredentialStore(join(root, "credentials.json"), {});

  assert.throws(() => store.setApiKey("exa", "   "), /API key must not be empty/);
  assert.deepEqual(store.getCredentialStatus("exa"), {
    configured: false,
    hasStoredCredential: false,
  });
});

test("setting a credential refuses to overwrite malformed JSON", (t) => {
  const root = temporaryDirectory("cinba-web-tools-credentials-", t);
  const path = join(root, "credentials.json");
  const malformed = "{ not-json";
  writeFileSync(path, malformed, "utf8");
  const store = createWebToolsCredentialStore(path, {});

  assert.throws(
    () => store.setApiKey("exa", "stored-exa-key"),
    /Credentials file contains malformed JSON/,
  );
  assert.equal(readFileSync(path, "utf8"), malformed);
});
