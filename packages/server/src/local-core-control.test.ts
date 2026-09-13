import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createLocalCoreControlHandler } from "./local-core-control.ts";

async function withControlServer(
  token: string | undefined,
  run: (baseUrl: string, stopped: () => number) => Promise<void>,
): Promise<void> {
  let stopRequests = 0;
  const control = createLocalCoreControlHandler({
    lifetime: "on-demand",
    token,
    snapshot: () => ({ clientCount: 2, safeToStop: false, draining: false }),
    requestStop: () => {
      stopRequests += 1;
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
    await run(`http://127.0.0.1:${address.port}`, () => stopRequests);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

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
