import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createLocalSyncControlHandler } from "./local-sync-control.ts";

async function withControlServer(
  token: string | undefined,
  run: (
    baseUrl: string,
    stopRequests: () => number,
    setActiveRequests: (count: number) => void,
  ) => Promise<void>,
): Promise<void> {
  let stops = 0;
  let activeRequests = 0;
  let draining = false;
  const control = createLocalSyncControlHandler({
    token,
    snapshot: () => ({ activeRequestCount: activeRequests, draining }),
    beginStop: () => {
      if (activeRequests > 0 || draining) {
        return false;
      }
      draining = true;
      return true;
    },
    requestStop: () => {
      stops += 1;
    },
  });
  const server = createServer((request, response) => {
    if (!control(request, response)) {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    await run(
      `http://127.0.0.1:${address.port}`,
      () => stops,
      (count) => {
        activeRequests = count;
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("local Sync control rejects an unauthenticated stop", async () => {
  await withControlServer("secret", async (baseUrl, stops) => {
    const response = await fetch(`${baseUrl}/local-sync/stop`, { method: "POST" });
    assert.equal(response.status, 401);
    assert.equal(stops(), 0);
  });
});

test("local Sync control reports ownership and schedules stop after responding", async () => {
  await withControlServer("secret", async (baseUrl, stops) => {
    const status = await fetch(`${baseUrl}/local-sync/status`, {
      headers: { authorization: "Bearer secret" },
    });
    assert.deepEqual(await status.json(), {
      status: "ok",
      pid: process.pid,
      activeRequestCount: 0,
      safeToStop: true,
      draining: false,
    });

    const response = await fetch(`${baseUrl}/local-sync/stop`, {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: "accepted" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stops(), 1);
  });
});

test("active business requests make Sync unsafe and reject stop without draining", async () => {
  await withControlServer("secret", async (baseUrl, stops, setActiveRequests) => {
    setActiveRequests(1);
    const status = await fetch(`${baseUrl}/local-sync/status`, {
      headers: { authorization: "Bearer secret" },
    });
    assert.deepEqual(await status.json(), {
      status: "ok",
      pid: process.pid,
      activeRequestCount: 1,
      safeToStop: false,
      draining: false,
    });

    const stop = await fetch(`${baseUrl}/local-sync/stop`, {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(stop.status, 409);
    assert.deepEqual(await stop.json(), { status: "busy", activeRequestCount: 1 });
    assert.equal(stops(), 0);

    setActiveRequests(0);
    const stillRunning = await fetch(`${baseUrl}/local-sync/status`, {
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(stillRunning.status, 200);
    assert.equal(((await stillRunning.json()) as { draining: boolean }).draining, false);
  });
});

test("stop rechecks activity after status and rejects a status-to-stop race", async () => {
  await withControlServer("secret", async (baseUrl, stops, setActiveRequests) => {
    const status = await fetch(`${baseUrl}/local-sync/status`, {
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(((await status.json()) as { safeToStop: boolean }).safeToStop, true);

    setActiveRequests(1);
    const stop = await fetch(`${baseUrl}/local-sync/stop`, {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(stop.status, 409);
    assert.equal(stops(), 0);
  });
});

test("local Sync control remains absent without a manager token", async () => {
  await withControlServer(undefined, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/local-sync/status`)).status, 404);
  });
});
