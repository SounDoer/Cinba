import { test } from "node:test";
import assert from "node:assert/strict";
import type { Socket, SocketFactory } from "@cinba/core-client";
import { verifyCoreConnection, waitForHealthyRevision } from "./verify.ts";

const TARGET = "abcdef1234567890abcdef1234567890abcdef12";

test("health verification retries until the exact revision is ready", async () => {
  let clock = 0;
  let attempts = 0;
  await waitForHealthyRevision({
    url: "http://127.0.0.1:4517/healthz",
    expectedRevision: TARGET,
    timeoutMs: 1_000,
    retryDelayMs: 100,
    now: () => clock,
    sleep: async (delayMs) => {
      clock += delayMs;
    },
    fetcher: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("not listening yet");
      }
      return Response.json({
        status: "ok",
        revision: attempts === 2 ? "0".repeat(40) : TARGET,
        safeToRestart: true,
      });
    },
  });

  assert.equal(attempts, 3);
  assert.equal(clock, 200);
});

test("health verification fails generically at the deadline", async () => {
  let clock = 0;
  await assert.rejects(
    waitForHealthyRevision({
      url: "http://127.0.0.1:4517/healthz",
      expectedRevision: TARGET,
      timeoutMs: 100,
      retryDelayMs: 100,
      now: () => clock,
      sleep: async (delayMs) => {
        clock += delayMs;
      },
      fetcher: async () => new Response("private upstream error", { status: 503 }),
    }),
    { message: "Target revision did not become healthy before the deadline" },
  );
});

function identifyingSocketFactory(onClosed: () => void): SocketFactory {
  return () => {
    const socket: Socket = {
      send: () => {},
      close: onClosed,
      onmessage: null,
      onopen: null,
      onerror: null,
      onclose: null,
    };
    queueMicrotask(() => {
      socket.onopen?.({});
      socket.onmessage?.({
        data: JSON.stringify({ type: "core_identity", name: "VPS Core" }),
      });
    });
    return socket;
  };
}

test("WebSocket verification waits for a valid core identity", async () => {
  let closed = false;
  await verifyCoreConnection({
    url: "ws://127.0.0.1:4517/ws",
    socketFactory: identifyingSocketFactory(() => {
      closed = true;
    }),
  });
  assert.equal(closed, true);
});

test("a socket error fails verification without reconnecting", async () => {
  let connections = 0;
  const socketFactory: SocketFactory = () => {
    connections += 1;
    const socket: Socket = {
      send: () => {},
      close: () => {},
      onmessage: null,
      onopen: null,
      onerror: null,
      onclose: null,
    };
    queueMicrotask(() => socket.onerror?.(new Error("refused")));
    return socket;
  };

  await assert.rejects(verifyCoreConnection({ url: "ws://127.0.0.1:4517/ws", socketFactory }), {
    message: "Core WebSocket connection failed",
  });
  assert.equal(connections, 1);
});
