import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import {
  LOCAL_SOURCES,
  resolveEffectiveSettings,
  resolveInitialModel,
} from "./effective-settings.ts";
import { createInstanceOverrideStore } from "./instance-override.ts";
import { createLocalSettingsStore } from "./local-settings.ts";

test("Local/Local defaults match the current Core defaults", () => {
  assert.deepEqual(
    resolveEffectiveSettings({
      sources: LOCAL_SOURCES,
      local: { defaultModel: undefined, webTools: { searchPrimary: "auto" } },
      override: {},
    }),
    { defaultModel: undefined, webTools: { searchPrimary: "auto" } },
  );
});

test("explicit session model, override, and Local Settings have field-level priority", () => {
  const local = {
    defaultModel: { provider: "deepseek", id: "local-model" },
    webTools: { searchPrimary: "exa" as const },
  };
  const effective = resolveEffectiveSettings({
    sources: LOCAL_SOURCES,
    local,
    override: {
      defaultModel: { provider: "openai", id: "override-model" },
      webTools: { searchPrimary: "brave" },
    },
  });

  assert.deepEqual(effective, {
    defaultModel: { provider: "openai", id: "override-model" },
    webTools: { searchPrimary: "brave" },
  });
  assert.deepEqual(resolveInitialModel({ provider: "groq", id: "session-model" }, effective), {
    provider: "groq",
    id: "session-model",
  });
});

test("resetting Override immediately follows Local Settings again", (t) => {
  const root = temporaryDirectory("cinba-effective-settings-", t);
  const local = createLocalSettingsStore(join(root, "local-settings.json"));
  const override = createInstanceOverrideStore(join(root, "instance-override.json"));
  local.setDefaultModel({ provider: "deepseek", id: "shared-local" });
  override.setDefaultModel({ provider: "openai", id: "only-here" });

  assert.equal(
    resolveEffectiveSettings({
      sources: LOCAL_SOURCES,
      local: local.get(),
      override: override.get(),
    }).defaultModel?.id,
    "only-here",
  );
  override.reset();
  assert.equal(
    resolveEffectiveSettings({
      sources: LOCAL_SOURCES,
      local: local.get(),
      override: override.get(),
    }).defaultModel?.id,
    "shared-local",
  );
});

test("choosing an explicit session model does not write a Settings file", (t) => {
  const root = temporaryDirectory("cinba-effective-settings-", t);
  const path = join(root, "local-settings.json");
  const local = createLocalSettingsStore(path);
  local.setDefaultModel({ provider: "deepseek", id: "local-default" });
  const before = readFileSync(path, "utf8");
  const effective = resolveEffectiveSettings({
    sources: LOCAL_SOURCES,
    local: local.get(),
    override: {},
  });

  assert.equal(
    resolveInitialModel({ provider: "openai", id: "one-session" }, effective)?.id,
    "one-session",
  );
  assert.equal(readFileSync(path, "utf8"), before);
});

test("Local Settings with Shared Credentials is rejected", () => {
  assert.throws(
    () =>
      resolveEffectiveSettings({
        sources: { settings: "local", credentials: "sync" },
        local: { defaultModel: undefined, webTools: { searchPrimary: "auto" } },
        override: {},
      }),
    /Local Settings cannot use Shared Credentials/,
  );
});
