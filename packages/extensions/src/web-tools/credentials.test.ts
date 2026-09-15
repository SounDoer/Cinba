import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWebToolsCredentialStore } from "./credentials.ts";

test("a missing credentials file reports both paid providers as unconfigured", () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-web-tools-credentials-"));
  try {
    const store = createWebToolsCredentialStore(join(root, "credentials.json"), {});

    assert.deepEqual(store.getCredentialStatus("exa"), {
      configured: false,
      hasStoredCredential: false,
    });
    assert.deepEqual(store.getCredentialStatus("brave"), {
      configured: false,
      hasStoredCredential: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an environment credential is reported without exposing its value", () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-web-tools-credentials-"));
  try {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stored credential is reported without exposing its value", () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-web-tools-credentials-"));
  try {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an environment credential takes precedence over a stored credential", () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-web-tools-credentials-"));
  try {
    const path = join(root, "credentials.json");
    writeFileSync(
      path,
      JSON.stringify({ webTools: { exa: { apiKey: "stored-exa-key" } } }),
      "utf8",
    );
    const store = createWebToolsCredentialStore(path, { EXA_API_KEY: "environment-exa-key" });

    assert.equal(store.getApiKey("exa"), "environment-exa-key");
    assert.deepEqual(store.getCredentialStatus("exa"), {
      configured: true,
      source: "environment",
      hasStoredCredential: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setting a credential makes it available to tools and redacted status", () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-web-tools-credentials-"));
  try {
    const store = createWebToolsCredentialStore(join(root, "credentials.json"), {});

    store.setApiKey("exa", "stored-exa-key");

    assert.equal(store.getApiKey("exa"), "stored-exa-key");
    assert.deepEqual(store.getCredentialStatus("exa"), {
      configured: true,
      source: "stored",
      hasStoredCredential: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setting one provider preserves another provider's credential", () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-web-tools-credentials-"));
  try {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setting a web tools credential preserves other credential namespaces", () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-web-tools-credentials-"));
  try {
    const path = join(root, "credentials.json");
    writeFileSync(path, JSON.stringify({ futureExtension: { token: "keep-me" } }), "utf8");
    const store = createWebToolsCredentialStore(path, {});

    store.setApiKey("exa", "stored-exa-key");

    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).futureExtension, {
      token: "keep-me",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearing removes only the selected stored credential", () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-web-tools-credentials-"));
  try {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setting an empty credential is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-web-tools-credentials-"));
  try {
    const store = createWebToolsCredentialStore(join(root, "credentials.json"), {});

    assert.throws(() => store.setApiKey("exa", "   "), /API key must not be empty/);
    assert.deepEqual(store.getCredentialStatus("exa"), {
      configured: false,
      hasStoredCredential: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setting a credential refuses to overwrite malformed JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-web-tools-credentials-"));
  try {
    const path = join(root, "credentials.json");
    const malformed = "{ not-json";
    writeFileSync(path, malformed, "utf8");
    const store = createWebToolsCredentialStore(path, {});

    assert.throws(
      () => store.setApiKey("exa", "stored-exa-key"),
      /Credentials file contains malformed JSON/,
    );
    assert.equal(readFileSync(path, "utf8"), malformed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
