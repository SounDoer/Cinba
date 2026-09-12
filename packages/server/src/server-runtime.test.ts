import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import WebSocket from "ws";
import { createServerRuntime } from "./server-runtime.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("start opens HTTP and stop releases the chosen port", async () => {
  const runtime = createServerRuntime({
    host: "127.0.0.1",
    port: 0,
    serveHttp: (_request, response) => {
      response.end("ready");
    },
    acceptWebSocket: () => true,
    onConnection: () => {},
  });

  const address = await runtime.start();
  try {
    const response = await fetch(`http://${address.host}:${address.port}/`);
    assert.equal(await response.text(), "ready");
  } finally {
    await runtime.stop();
  }

  const replacement = createServer();
  await new Promise<void>((resolve) => replacement.listen(address.port, address.host, resolve));
  await new Promise<void>((resolve, reject) => {
    replacement.close((error) => (error ? reject(error) : resolve()));
  });
});

test("WebSocket connections are delegated on the configured path", async () => {
  let connected = false;
  const runtime = createServerRuntime({
    host: "127.0.0.1",
    port: 0,
    webSocketPath: "/socket",
    serveHttp: (_request, response) => {
      response.end("ready");
    },
    acceptWebSocket: () => true,
    onConnection: (socket) => {
      connected = true;
      socket.send("hello");
    },
  });

  const address = await runtime.start();
  const socket = new WebSocket(`ws://${address.host}:${address.port}/socket`);
  try {
    const message = await new Promise<string>((resolve, reject) => {
      socket.once("message", (data) => resolve(String(data)));
      socket.once("error", reject);
    });

    assert.equal(connected, true);
    assert.equal(message, "hello");
  } finally {
    socket.close();
    await new Promise<void>((resolve) => socket.once("close", resolve));
    await runtime.stop();
  }
});

test("a refused WebSocket handshake never reaches the connection handler", async () => {
  let connected = false;
  const runtime = createServerRuntime({
    host: "127.0.0.1",
    port: 0,
    serveHttp: (_request, response) => {
      response.end("ready");
    },
    acceptWebSocket: () => false,
    onConnection: () => {
      connected = true;
    },
  });

  const address = await runtime.start();
  const socket = new WebSocket(`ws://${address.host}:${address.port}/ws`);
  try {
    const status = await new Promise<number>((resolve, reject) => {
      socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.once("error", reject);
    });
    assert.equal(status, 401);
    assert.equal(connected, false);
  } finally {
    socket.close();
    await runtime.stop();
  }
});

test("maintenance begins on start and ends on stop", async () => {
  let runs = 0;
  const runtime = createServerRuntime({
    host: "127.0.0.1",
    port: 0,
    serveHttp: (_request, response) => {
      response.end();
    },
    acceptWebSocket: () => true,
    onConnection: () => {},
    maintain: () => {
      runs += 1;
    },
    maintenanceIntervalMs: 10,
  });

  await wait(30);
  assert.equal(runs, 0, "creating the runtime must not start its clock");

  await runtime.start();
  await wait(35);
  assert.ok(runs > 0, "starting the runtime should start maintenance");

  await runtime.stop();
  const stoppedAt = runs;
  await wait(30);
  assert.equal(runs, stoppedAt, "stopping the runtime must clear its clock");
});
