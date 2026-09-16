import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProviderEnvironment,
  localProviderEnvironmentCredential,
  providerEnvironmentVariable,
} from "./provider-environment.ts";

test("only the selected Provider key enters the Pi environment", () => {
  const environment = buildProviderEnvironment({
    providerId: "anthropic",
    apiKey: "shared-anthropic",
    baseEnvironment: {
      PATH: "/bin",
      ANTHROPIC_API_KEY: "parent-anthropic",
      OPENAI_API_KEY: "parent-openai",
      MOONSHOT_API_KEY: "parent-moonshot",
      EXA_API_KEY: "parent-exa",
    },
  });
  assert.equal(environment.ANTHROPIC_API_KEY, "shared-anthropic");
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.MOONSHOT_API_KEY, undefined);
  assert.equal(environment.EXA_API_KEY, undefined);
  assert.equal(environment.PATH, "/bin");
});

test("Provider mappings are explicit, including shared environment variables", () => {
  assert.equal(providerEnvironmentVariable("moonshotai-cn"), "MOONSHOT_API_KEY");
  assert.equal(providerEnvironmentVariable("unknown"), undefined);
  assert.equal(
    localProviderEnvironmentCredential("deepseek", { DEEPSEEK_API_KEY: "local-key" }),
    "local-key",
  );
});
