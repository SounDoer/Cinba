import assert from "node:assert/strict";
import test from "node:test";
import { SyncClientError } from "@cinba/sync-client";
import { consumeCredentialDraft, errorMessage, manualModel, modelLabel } from "./view-model.ts";

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
