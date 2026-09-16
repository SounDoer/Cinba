import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertLoopbackSyncHost, createSyncServer, runSyncServer } from "./server.ts";
import { syncMaintenancePath } from "./services/backup-service.ts";

test("the standalone Sync server serves health, API, and the same-origin web application", async () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-sync-server-"));
  const webRoot = join(root, "web");
  const stateDirectory = join(root, "state");
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, "index.html"), "<h1>Sync UI</h1>");
  const server = createSyncServer({
    stateDirectory,
    host: "127.0.0.1",
    port: 0,
    publicOrigin: "http://127.0.0.1:4518",
    webRoot,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { status: string }).status, "ok");
    assert.equal(await (await fetch(origin)).text(), "<h1>Sync UI</h1>");
    assert.equal((await fetch(`${origin}/api/unknown`)).status, 404);
    const lock = syncMaintenancePath(stateDirectory);
    writeFileSync(lock, "maintenance");
    const mutation = await fetch(`${origin}/api/core/enrollments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        name: "Maintenance Probe",
        platform: "linux",
        appVersion: "1.0.0",
        credentialSource: "local",
      }),
    });
    assert.equal(mutation.status, 503);
    unlinkSync(lock);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Sync refuses public binds and HTTPS mode requires the expected proxy headers", async () => {
  assert.throws(() => assertLoopbackSyncHost("0.0.0.0"), /loopback/);
  const root = mkdtempSync(join(tmpdir(), "cinba-sync-proxy-"));
  const webRoot = join(root, "web");
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, "index.html"), "Sync");
  const server = createSyncServer({
    stateDirectory: join(root, "state"),
    host: "127.0.0.1",
    port: 0,
    publicOrigin: "https://sync.example.ts.net",
    webRoot,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(origin)).status, 400);
    assert.equal(
      (
        await fetch(origin, {
          headers: {
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "sync.example.ts.net",
          },
        })
      ).status,
      200,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the persistent service starts without a TTY and closes on a lifecycle signal", async () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-sync-lifecycle-"));
  const webRoot = join(root, "web");
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, "index.html"), "Sync");
  const probe = createSyncServer({
    stateDirectory: join(root, "probe"),
    host: "127.0.0.1",
    port: 0,
    publicOrigin: "http://127.0.0.1:4518",
    webRoot,
  });
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const signals = new EventEmitter();
  const running = runSyncServer(
    {
      stateDirectory: join(root, "state"),
      host: "127.0.0.1",
      port,
      publicOrigin: `http://127.0.0.1:${port}`,
      webRoot,
    },
    signals,
  );
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) {
        break;
      }
    } catch {
      if (Date.now() >= deadline) {
        throw new Error("Sync service did not start");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  signals.emit("SIGTERM");
  await running;
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/health`));
});
