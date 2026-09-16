import assert from "node:assert/strict";
import test from "node:test";
import { SyncClientError } from "@cinba/sync-client";
import {
  MANUAL_MODEL_SELECTION,
  SHARED_CREDENTIAL_PROVIDERS,
  consumeCredentialDraft,
  errorMessage,
  initialModelSelection,
  manualModel,
  modelLabel,
} from "./view-model.ts";

test("model selection distinguishes no default, reported models, and manual fallback", () => {
  const candidates = [
    {
      model: { provider: "anthropic", id: "claude" },
      supportedCoreIds: ["one"],
      unsupportedCoreIds: [],
    },
  ];
  assert.equal(initialModelSelection(undefined, candidates), "");
  assert.equal(
    initialModelSelection({ provider: "anthropic", id: "claude" }, candidates),
    "anthropic\0claude",
  );
  assert.equal(
    initialModelSelection({ provider: "custom", id: "model" }, candidates),
    MANUAL_MODEL_SELECTION,
  );
});

test("shared credential choices are unique and include model and search providers", () => {
  const ids = SHARED_CREDENTIAL_PROVIDERS.map((provider) => provider.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes("anthropic"));
  assert.ok(ids.includes("openai"));
  assert.ok(ids.includes("exa"));
  assert.ok(ids.includes("brave"));
});

test("describes revision conflicts without suggesting an overwrite", () => {
  const error = new SyncClientError({
    kind: "http",
    message: "conflict",
    status: 409,
    code: "conflict",
  });
  assert.match(errorMessage(error), /Reload the latest revision/);
});

test("clears a credential draft before returning it for submission", () => {
  let cleared = false;
  assert.equal(
    consumeCredentialDraft(" secret ", () => (cleared = true)),
    "secret",
  );
  assert.equal(cleared, true);
});

test("labels partial model support and allows a manual model", () => {
  const candidate = {
    model: { provider: "anthropic", id: "claude" },
    supportedCoreIds: ["one"],
    unsupportedCoreIds: ["two"],
  };
  assert.equal(modelLabel(candidate, 2), "anthropic/claude · 1/2 Cores");
  assert.deepEqual(manualModel(" openai ", " gpt-5 "), { provider: "openai", id: "gpt-5" });
  assert.equal(manualModel("", "gpt-5"), undefined);
});

test("turns an invalid session into a sign-in instruction", () => {
  assert.equal(
    errorMessage(new SyncClientError({ kind: "http", message: "unauthorized", status: 401 })),
    "Your session has expired. Sign in again.",
  );
});
