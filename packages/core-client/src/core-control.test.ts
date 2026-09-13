import assert from "node:assert/strict";
import { test } from "node:test";
import { requestLocalCoreStatus, requestLocalCoreStop } from "./core-control.ts";
import type { HttpFetcher, HttpRequestInit } from "./http.ts";

const STATUS = {
  status: "ok",
  lifetime: "on-demand",
  pid: 123,
  clientCount: 2,
  safeToStop: false,
  draining: false,
} as const;

test("reads protected local Core status", async () => {
  let requested = "";
  let requestInit: HttpRequestInit | undefined;
  const fetcher: HttpFetcher = async (input, init) => {
    requested = input;
    requestInit = init;
    return { ok: true, json: async () => STATUS };
  };

  assert.deepEqual(
    await requestLocalCoreStatus("http://127.0.0.1:4517/", "secret", { fetcher }),
    STATUS,
  );
  assert.equal(requested, "http://127.0.0.1:4517/local-core/status");
  assert.equal(requestInit?.headers?.authorization, "Bearer secret");
});

test("requests a protected graceful stop", async () => {
  let requestInit: HttpRequestInit | undefined;
  const accepted = await requestLocalCoreStop("http://127.0.0.1:4517/", "secret", {
    fetcher: async (_input, init) => {
      requestInit = init;
      return { ok: true, json: async () => ({ status: "accepted" }) };
    },
  });

  assert.equal(accepted, true);
  assert.equal(requestInit?.method, "POST");
  assert.equal(requestInit?.headers?.authorization, "Bearer secret");
});

test("rejects malformed or refused control responses", async () => {
  assert.equal(
    await requestLocalCoreStatus("http://127.0.0.1:4517/", "secret", {
      fetcher: async () => ({ ok: true, json: async () => ({ status: "ok" }) }),
    }),
    undefined,
  );
  assert.equal(
    await requestLocalCoreStop("http://127.0.0.1:4517/", "secret", {
      fetcher: async () => ({ ok: false, json: async () => ({ status: "accepted" }) }),
    }),
    false,
  );
});
