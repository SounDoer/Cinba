import assert from "node:assert/strict";
import test from "node:test";
import { CoreSyncControlClient, CoreSyncControlError, coreHttpOrigin } from "./sync-control.ts";
import type { HttpFetcher, HttpRequestInit } from "./http.ts";

const VIEW = {
  version: 1,
  state: "stale",
  sources: { settings: "sync", credentials: "local" },
  effectiveSettingsSource: "sync",
  serverUrl: "https://sync.example.test",
  managementUrl: "https://sync.example.test/",
  syncRevision: 3,
  errorCode: "offline",
  action: "retry",
  shared: { webTools: { searchPrimary: "exa" } },
  override: {},
  effective: { webTools: { searchPrimary: "exa" } },
} as const;

test("maps a Core WebSocket URL to its HTTP control origin", () => {
  assert.equal(coreHttpOrigin("ws://127.0.0.1:4517/ws"), "http://127.0.0.1:4517");
  assert.equal(coreHttpOrigin("wss://core.example.test/ws"), "https://core.example.test");
});

test("each current Core Sync operation uses its typed route", async () => {
  const seen: { url: string; init?: HttpRequestInit }[] = [];
  const fetcher: HttpFetcher = async (url, init) => {
    seen.push({ url, ...(init ? { init } : {}) });
    return {
      ok: true,
      json: async () => (url.endsWith("/status") ? VIEW : { version: 1, accepted: true }),
    };
  };
  const client = new CoreSyncControlClient("ws://core.test/ws", { fetcher });

  assert.equal((await client.status()).state, "stale");
  await client.connect("https://sync.example.test", { settings: "sync", credentials: "local" });
  await client.cancelEnrollment();
  await client.disconnect();
  await client.syncNow();
  await client.updateSources({ settings: "sync", credentials: "sync" });
  await client.updateOverride({ webTools: { searchPrimary: "brave" } });

  assert.deepEqual(
    seen.map(({ url, init }) => [new URL(url).pathname, init?.method ?? "GET"]),
    [
      ["/api/sync/status", "GET"],
      ["/api/sync/connect", "POST"],
      ["/api/sync/connect/cancel", "POST"],
      ["/api/sync/disconnect", "POST"],
      ["/api/sync/now", "POST"],
      ["/api/sync/sources", "PUT"],
      ["/api/sync/override", "PUT"],
    ],
  );
});

test("manual Sync coalesces duplicate in-flight clicks", async () => {
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = new CoreSyncControlClient("http://core.test", {
    fetcher: async () => {
      calls += 1;
      await blocked;
      return { ok: true, json: async () => ({ version: 1, accepted: true }) };
    },
  });
  const first = client.syncNow();
  const second = client.syncNow();
  assert.equal(first, second);
  release();
  await first;
  assert.equal(calls, 1);
});

test("timeouts and refused responses have stable error kinds and later calls recover", async () => {
  let call = 0;
  const client = new CoreSyncControlClient("http://core.test", {
    timeoutMs: 5,
    fetcher: async (_url, init) => {
      call += 1;
      if (call === 1) {
        await new Promise((_resolve, reject) => {
          assert(init?.signal);
          (init.signal as AbortSignal).addEventListener("abort", () => reject(new Error("abort")));
        });
      }
      if (call === 2) {
        return { ok: false, status: 409, json: async () => ({}) } as never;
      }
      return { ok: true, json: async () => VIEW };
    },
  });
  await assert.rejects(client.status(), (error: unknown) => {
    assert(error instanceof CoreSyncControlError);
    return error.kind === "unavailable";
  });
  await assert.rejects(client.status(), (error: unknown) => {
    assert(error instanceof CoreSyncControlError);
    return error.kind === "refused" && error.status === 409;
  });
  assert.equal((await client.status()).state, "stale");
});
