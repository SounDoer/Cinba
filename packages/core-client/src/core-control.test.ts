import assert from "node:assert/strict";
import { test } from "node:test";
import {
  requestLocalCoreLifetime,
  requestLocalCoreStatus,
  requestLocalCoreStop,
  requestLocalCoreSyncEnrollment,
  requestLocalCoreSyncHostDeletePreparation,
} from "./core-control.ts";
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

test("requests protected preparation for Sync Host deletion", async () => {
  let requested = "";
  let requestInit: HttpRequestInit | undefined;
  const accepted = await requestLocalCoreSyncHostDeletePreparation(
    "http://127.0.0.1:4517/",
    "secret",
    {
      fetcher: async (input, init) => {
        requested = input;
        requestInit = init;
        return { ok: true, json: async () => ({ status: "accepted" }) };
      },
    },
  );

  assert.equal(accepted, true);
  assert.equal(requested, "http://127.0.0.1:4517/local-core/prepare-sync-host-delete");
  assert.equal(requestInit?.method, "POST");
  assert.equal(requestInit?.headers?.authorization, "Bearer secret");
});

test("requests a protected Core lifetime change", async () => {
  let requested = "";
  let requestInit: HttpRequestInit | undefined;
  const accepted = await requestLocalCoreLifetime(
    "http://127.0.0.1:4517/",
    "secret",
    "persistent",
    {
      fetcher: async (input, init) => {
        requested = input;
        requestInit = init;
        return {
          ok: true,
          json: async () => ({ status: "accepted", lifetime: "persistent" }),
        };
      },
    },
  );

  assert.equal(accepted, true);
  assert.equal(requested, "http://127.0.0.1:4517/local-core/lifetime/persistent");
  assert.equal(requestInit?.method, "POST");
  assert.equal(requestInit?.headers?.authorization, "Bearer secret");
});

test("requests and strictly parses a protected local Sync enrollment receipt", async () => {
  let requested = "";
  let requestInit: HttpRequestInit | undefined;
  const receipt = await requestLocalCoreSyncEnrollment(
    "http://127.0.0.1:4517/",
    "secret",
    "http://127.0.0.1:4518",
    {
      fetcher: async (input, init) => {
        requested = input;
        requestInit = init;
        return {
          ok: true,
          json: async () => ({
            status: "ok",
            enrollmentId: "enrollment-id",
            enrollmentSecret: "enrollment-secret",
            expiresAt: "2026-09-21T12:00:00.000Z",
            settings: { version: 1, webTools: { searchPrimary: "auto" } },
          }),
        };
      },
    },
  );
  assert.deepEqual(receipt, {
    enrollmentId: "enrollment-id",
    enrollmentSecret: "enrollment-secret",
    expiresAt: "2026-09-21T12:00:00.000Z",
    settings: { version: 1, webTools: { searchPrimary: "auto" } },
  });
  assert.equal(requested, "http://127.0.0.1:4517/local-core/sync-enrollment");
  assert.equal(requestInit?.headers?.authorization, "Bearer secret");
  assert.equal(requestInit?.headers?.["content-type"], "application/json");
  assert.equal(requestInit?.body, JSON.stringify({ serverUrl: "http://127.0.0.1:4518" }));

  assert.equal(
    await requestLocalCoreSyncEnrollment(
      "http://127.0.0.1:4517/",
      "secret",
      "http://127.0.0.1:4518",
      {
        fetcher: async () => ({
          ok: true,
          json: async () => ({ status: "ok", enrollmentSecret: "incomplete" }),
        }),
      },
    ),
    undefined,
  );
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
