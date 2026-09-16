import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInstanceOverrideStore } from "./instance-override.ts";
import { createLocalSettingsStore } from "./local-settings.ts";

test("Local Settings persist a complete versioned document", () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-settings-store-"));
  try {
    const path = join(root, "local-settings.json");
    const store = createLocalSettingsStore(path);
    store.setDefaultModel({ provider: "deepseek", id: "deepseek-chat" });
    store.setWebSearchPrimary("brave");

    assert.deepEqual(createLocalSettingsStore(path).get(), {
      defaultModel: { provider: "deepseek", id: "deepseek-chat" },
      webTools: { searchPrimary: "brave" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Instance Override removes individual fields instead of copying base values", () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-settings-store-"));
  try {
    const path = join(root, "instance-override.json");
    const store = createInstanceOverrideStore(path);
    store.setDefaultModel({ provider: "openai", id: "gpt-test" });
    store.setWebSearchPrimary("exa");
    store.setDefaultModel(undefined);

    assert.deepEqual(store.get(), { webTools: { searchPrimary: "exa" } });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      version: 1,
      webTools: { searchPrimary: "exa" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Local Settings preserves malformed JSON and refuses overwrite", () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-settings-store-"));
  try {
    const path = join(root, "store.json");
    const original = "{ not valid";
    writeFileSync(path, original);
    const store = createLocalSettingsStore(path);

    assert.ok(store.problem());
    assert.throws(() => store.setWebSearchPrimary("brave"), /unreadable or unsupported/);
    assert.equal(readFileSync(path, "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Instance Override preserves malformed JSON and refuses overwrite", () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-settings-store-"));
  try {
    const path = join(root, "store.json");
    const original = "{ not valid";
    writeFileSync(path, original);
    const store = createInstanceOverrideStore(path);

    assert.ok(store.problem());
    assert.throws(() => store.reset(), /unreadable or unsupported/);
    assert.equal(readFileSync(path, "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown Settings versions are fail-closed", () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-settings-store-"));
  try {
    const path = join(root, "local-settings.json");
    const original = JSON.stringify({
      version: 99,
      webTools: { searchPrimary: "auto" },
    });
    writeFileSync(path, original);
    const store = createLocalSettingsStore(path);

    assert.ok(store.problem());
    assert.throws(() => store.setWebSearchPrimary("exa"), /unreadable or unsupported/);
    assert.equal(readFileSync(path, "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
