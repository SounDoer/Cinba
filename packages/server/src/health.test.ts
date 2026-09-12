import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHealthHandler, isSafeToRestart, normalizeRevision } from "./health.ts";

test("only Git-shaped revisions are exposed", () => {
  assert.equal(normalizeRevision("ABCDEF1234567"), "abcdef1234567");
  assert.equal(normalizeRevision(undefined), "unknown");
  assert.equal(normalizeRevision("main"), "unknown");
  assert.equal(normalizeRevision("secret value"), "unknown");
});

test("restart is safe only when no session is answering or awaiting confirmation", () => {
  assert.equal(isSafeToRestart([]), true);
  assert.equal(isSafeToRestart([{ busy: false, awaitingConfirmation: false }]), true);
  assert.equal(isSafeToRestart([{ busy: true, awaitingConfirmation: false }]), false);
  assert.equal(isSafeToRestart([{ busy: false, awaitingConfirmation: true }]), false);
});

test("GET /healthz reports liveness, revision, and restart safety", async () => {
  const health = createHealthHandler({
    revision: "abcdef1",
    safeToRestart: () => false,
  });
  const server = createServer((request, response) => {
    if (!health(request, response)) {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      status: "ok",
      revision: "abcdef1",
      safeToRestart: false,
    });

    const missing = await fetch(`http://127.0.0.1:${address.port}/elsewhere`);
    assert.equal(missing.status, 404);

    const wrongMethod = await fetch(`http://127.0.0.1:${address.port}/healthz`, {
      method: "POST",
    });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
