import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { CoreSyncView } from "@cinba/contract";
import { createCoreSyncControlHandler } from "./sync-control.ts";

const VIEW: CoreSyncView = {
  version: 1,
  state: "disconnected",
  sources: { settings: "local", credentials: "local" },
  effectiveSettingsSource: "local",
  override: {},
  effective: { webTools: { searchPrimary: "auto" } },
};

async function withServer(
  exercise: (baseUrl: string, calls: string[]) => Promise<void>,
): Promise<void> {
  const calls: string[] = [];
  const handler = createCoreSyncControlHandler({
    view: () => VIEW,
    connect: async (request) => void calls.push(`connect:${request.serverUrl}`),
    cancel: () => void calls.push("cancel"),
    disconnect: async () => void calls.push("disconnect"),
    syncNow: async () => void calls.push("sync"),
    updateSources: async (request) =>
      void calls.push(`sources:${request.sources.settings}/${request.sources.credentials}`),
    updateOverride: (request) =>
      void calls.push(`override:${request.override.webTools?.searchPrimary ?? "shared"}`),
  });
  const server = createServer((request, response) => {
    void handler(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    await exercise(`http://127.0.0.1:${address.port}`, calls);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("exposes a no-store current Core status", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sync/status`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), VIEW);
  });
});

test("routes connect, source, override, sync and disconnect operations", async () => {
  await withServer(async (baseUrl, calls) => {
    const json = (body: unknown) => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(
      (
        await fetch(
          `${baseUrl}/api/sync/connect`,
          json({
            version: 1,
            serverUrl: "https://sync.example.test",
            sources: { settings: "sync", credentials: "local" },
          }),
        )
      ).status,
      200,
    );
    await fetch(
      `${baseUrl}/api/sync/sources`,
      json({ version: 1, sources: { settings: "sync", credentials: "sync" } }),
    );
    await fetch(
      `${baseUrl}/api/sync/override`,
      json({ version: 1, override: { webTools: { searchPrimary: "exa" } } }),
    );
    await fetch(`${baseUrl}/api/sync/now`, { method: "POST" });
    await fetch(`${baseUrl}/api/sync/disconnect`, { method: "POST" });
    assert.deepEqual(calls, [
      "connect:https://sync.example.test",
      "sources:sync/sync",
      "override:exa",
      "sync",
      "disconnect",
    ]);
  });
});

test("rejects invalid source combinations and cross-site mutation", async () => {
  await withServer(async (baseUrl, calls) => {
    const invalid = await fetch(`${baseUrl}/api/sync/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        serverUrl: "https://sync.example.test",
        sources: { settings: "local", credentials: "sync" },
      }),
    });
    assert.equal(invalid.status, 400);
    const crossSite = await fetch(`${baseUrl}/api/sync/disconnect`, {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    assert.equal(crossSite.status, 403);
    const foreignOrigin = await fetch(`${baseUrl}/api/sync/disconnect`, {
      method: "POST",
      headers: { origin: "https://attacker.example" },
    });
    assert.equal(foreignOrigin.status, 403);
    assert.deepEqual(calls, []);
  });
});
