import assert from "node:assert/strict";
import { test } from "node:test";
import { type HealthFetcher, probeCoreHealth } from "./core-health.ts";

function fetches(body: unknown, ok = true): HealthFetcher {
  return async () => ({ ok, json: async () => body });
}

test("accepts a valid Cinba health response", async () => {
  const health = await probeCoreHealth("http://127.0.0.1:4517/", {
    fetcher: fetches({ status: "ok", revision: "abcdef1", safeToRestart: true }),
  });

  assert.deepEqual(health, {
    status: "ok",
    revision: "abcdef1",
    safeToRestart: true,
  });
});

test("requests the health path relative to the Core URL", async () => {
  let requested = "";
  await probeCoreHealth("https://example.test/cinba", {
    fetcher: async (input) => {
      requested = input;
      return {
        ok: true,
        json: async () => ({ status: "ok", revision: "unknown", safeToRestart: false }),
      };
    },
  });

  assert.equal(requested, "https://example.test/healthz");
});

test("rejects non-Core and failed responses", async () => {
  assert.equal(
    await probeCoreHealth("http://127.0.0.1:4517/", { fetcher: fetches({ status: "ok" }) }),
    undefined,
  );
  assert.equal(
    await probeCoreHealth("http://127.0.0.1:4517/", {
      fetcher: fetches({ status: "ok", revision: "abcdef1", safeToRestart: true }, false),
    }),
    undefined,
  );
  assert.equal(
    await probeCoreHealth("http://127.0.0.1:4517/", {
      fetcher: async () => {
        throw new Error("offline");
      },
    }),
    undefined,
  );
});
