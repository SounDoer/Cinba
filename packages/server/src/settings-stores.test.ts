import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import { createInstanceOverrideStore } from "./instance-override.ts";
import { createLocalSettingsStore } from "./local-settings.ts";

test("Local Settings persist a complete versioned document", (t) => {
  const root = temporaryDirectory("cinba-settings-store-", t);
  const path = join(root, "local-settings.json");
  const store = createLocalSettingsStore(path);
  store.setDefaultModel({ provider: "deepseek", id: "deepseek-chat" });
  store.setWebSearchPrimary("brave");

  assert.deepEqual(createLocalSettingsStore(path).get(), {
    defaultModel: { provider: "deepseek", id: "deepseek-chat" },
    webTools: { searchPrimary: "brave" },
  });
});

test("Local Settings replace a complete shared snapshot atomically", (t) => {
  const root = temporaryDirectory("cinba-settings-store-replace-", t);
  const path = join(root, "local-settings.json");
  const store = createLocalSettingsStore(path);

  store.set({
    defaultModel: { provider: "openai", id: "gpt-shared" },
    webTools: { searchPrimary: "exa" },
  });

  assert.deepEqual(createLocalSettingsStore(path).get(), {
    defaultModel: { provider: "openai", id: "gpt-shared" },
    webTools: { searchPrimary: "exa" },
  });
});

test("Instance Override removes individual fields instead of copying base values", (t) => {
  const root = temporaryDirectory("cinba-settings-store-", t);
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
});

test("Local Settings preserves malformed JSON and refuses overwrite", (t) => {
  const root = temporaryDirectory("cinba-settings-store-", t);
  const path = join(root, "store.json");
  const original = "{ not valid";
  writeFileSync(path, original);
  const store = createLocalSettingsStore(path);

  assert.ok(store.problem());
  assert.throws(() => store.setWebSearchPrimary("brave"), /unreadable or unsupported/);
  assert.equal(readFileSync(path, "utf8"), original);
});

test("Instance Override preserves malformed JSON and refuses overwrite", (t) => {
  const root = temporaryDirectory("cinba-settings-store-", t);
  const path = join(root, "store.json");
  const original = "{ not valid";
  writeFileSync(path, original);
  const store = createInstanceOverrideStore(path);

  assert.ok(store.problem());
  assert.throws(() => store.reset(), /unreadable or unsupported/);
  assert.equal(readFileSync(path, "utf8"), original);
});

test("unknown Settings versions are fail-closed", (t) => {
  const root = temporaryDirectory("cinba-settings-store-", t);
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
});
