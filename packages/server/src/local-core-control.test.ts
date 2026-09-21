import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createLocalCoreControlHandler } from "./local-core-control.ts";

async function withControlServer(
  token: string | undefined,
  run: (
    baseUrl: string,
    stopped: () => number,
    lifetime: () => "persistent" | "on-demand",
    deletePreparations: () => number,
  ) => Promise<void>,
): Promise<void> {
  let stopRequests = 0;
  let deletePreparations = 0;
  let lifetime: "persistent" | "on-demand" = "on-demand";
  const control = createLocalCoreControlHandler({
    lifetime: () => lifetime,
    token,
    snapshot: () => ({ clientCount: 2, safeToStop: false, draining: false }),
    requestStop: () => {
      stopRequests += 1;
    },
    setLifetime: (next) => {
      lifetime = next;
    },
    beginSyncEnrollment: async () => {
      return {
        enrollmentId: "enrollment-id",
        enrollmentSecret: "enrollment-secret",
        expiresAt: "2026-09-21T12:00:00.000Z",
        settings: { version: 1, webTools: { searchPrimary: "auto" } },
      };
    },
    prepareSyncHostDelete: async () => {
      deletePreparations += 1;
    },
  });
  const server = createServer(async (request, response) => {
    if (!(await control(request, response))) {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    await run(
      `http://127.0.0.1:${address.port}`,
      () => stopRequests,
      () => lifetime,
      () => deletePreparations,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("an authorized manager can prepare the current Core for Host deletion", async () => {
  await withControlServer("secret", async (baseUrl, _stopped, _lifetime, preparations) => {
    const response = await fetch(`${baseUrl}/local-core/prepare-sync-host-delete`, {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: "accepted" });
    assert.equal(preparations(), 1);
  });
});

test("an authorized manager can begin one local Sync enrollment", async () => {
  await withControlServer("secret", async (baseUrl) => {
    const response = await fetch(`${baseUrl}/local-core/sync-enrollment`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ serverUrl: "http://127.0.0.1:4518" }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      status: "ok",
      enrollmentId: "enrollment-id",
      enrollmentSecret: "enrollment-secret",
      expiresAt: "2026-09-21T12:00:00.000Z",
      settings: { version: 1, webTools: { searchPrimary: "auto" } },
    });

    const extra = await fetch(`${baseUrl}/local-core/sync-enrollment`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ serverUrl: "http://127.0.0.1:4518", extra: true }),
    });
    assert.equal(extra.status, 400);
  });
});

test("an authorized manager can inspect on-demand Core state", async () => {
  await withControlServer("secret", async (baseUrl) => {
    const response = await fetch(`${baseUrl}/local-core/status`, {
      headers: { authorization: "Bearer secret" },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      lifetime: "on-demand",
      pid: process.pid,
      clientCount: 2,
      safeToStop: false,
      draining: false,
    });
  });
});

test("a graceful stop is accepted before drain starts", async () => {
  await withControlServer("secret", async (baseUrl, stopped) => {
    const response = await fetch(`${baseUrl}/local-core/stop`, {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: "accepted" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped(), 1);
  });
});

test("an authorized manager can keep a Core persistently available", async () => {
  await withControlServer("secret", async (baseUrl, _stopped, lifetime) => {
    const response = await fetch(`${baseUrl}/local-core/lifetime/persistent`, {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: "accepted", lifetime: "persistent" });
    assert.equal(lifetime(), "persistent");

    const status = await fetch(`${baseUrl}/local-core/status`, {
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(((await status.json()) as { lifetime: string }).lifetime, "persistent");
  });
});

test("missing credentials are refused and a disabled control surface stays absent", async () => {
  await withControlServer("secret", async (baseUrl, stopped) => {
    const response = await fetch(`${baseUrl}/local-core/stop`, { method: "POST" });
    assert.equal(response.status, 401);
    assert.equal(stopped(), 0);
  });
  await withControlServer(undefined, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/local-core/status`);
    assert.equal(response.status, 404);
  });
});
