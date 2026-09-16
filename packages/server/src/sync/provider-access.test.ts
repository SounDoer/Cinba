import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderCredentialConflictError,
  ProviderLoginRequiredError,
  resolveProviderCredential,
} from "./provider-access.ts";

test("Local and Shared Provider credentials resolve without leaking unrelated keys", () => {
  assert.equal(
    resolveProviderCredential({
      providerId: "openai",
      source: "local",
      environment: { OPENAI_API_KEY: "local-openai", ANTHROPIC_API_KEY: "unrelated" },
    }),
    "local-openai",
  );
  assert.equal(
    resolveProviderCredential({
      providerId: "openai",
      source: "sync",
      sharedCredential: "shared-openai",
    }),
    "shared-openai",
  );
});

test("local API-key conflict and missing local OAuth are distinct safe failures", () => {
  assert.throws(
    () =>
      resolveProviderCredential({
        providerId: "openai",
        source: "sync",
        sharedCredential: "must-not-appear",
        localAuthType: "api_key",
      }),
    (error: unknown) =>
      error instanceof ProviderCredentialConflictError &&
      !error.message.includes("must-not-appear"),
  );
  assert.throws(
    () => resolveProviderCredential({ providerId: "openrouter", source: "sync" }),
    ProviderLoginRequiredError,
  );
  assert.equal(
    resolveProviderCredential({
      providerId: "openrouter",
      source: "sync",
      localAuthType: "oauth",
    }),
    undefined,
  );
});
