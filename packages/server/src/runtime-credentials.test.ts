import assert from "node:assert/strict";
import test from "node:test";
import {
  MissingSharedCredentialError,
  createRuntimeCredentialResolver,
} from "./runtime-credentials.ts";

test("Runtime Credentials return only the requested Local provider key", () => {
  const requested: string[] = [];
  const resolver = createRuntimeCredentialResolver({
    sources: { settings: "local", credentials: "local" },
    local: (providerId) => {
      requested.push(providerId);
      return providerId === "deepseek" ? "deepseek-key" : undefined;
    },
  });

  assert.equal(resolver.get("deepseek"), "deepseek-key");
  assert.deepEqual(requested, ["deepseek"]);
  assert.deepEqual(Object.keys(resolver), ["get"]);
});

test("Shared Credentials require Sync Settings and an explicit lookup", () => {
  assert.throws(
    () =>
      createRuntimeCredentialResolver({
        sources: { settings: "local", credentials: "sync" },
        local: () => undefined,
        shared: () => "shared",
      }),
    /Local Settings cannot use Shared Credentials/,
  );
  let localReads = 0;
  const missing = createRuntimeCredentialResolver({
    sources: { settings: "sync", credentials: "sync" },
    local: () => {
      localReads += 1;
      return "must-not-fallback";
    },
  });
  assert.throws(() => missing.get("deepseek"), MissingSharedCredentialError);
  assert.equal(localReads, 0);
});
