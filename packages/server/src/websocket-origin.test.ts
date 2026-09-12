import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { isAllowedWebSocketOrigin } from "./websocket-origin.ts";

function request(origin: string | undefined, host: string | undefined): IncomingMessage {
  return { headers: { origin, host } } as IncomingMessage;
}

test("a client without Origin is allowed for non-browser use", () => {
  assert.equal(isAllowedWebSocketOrigin(request(undefined, undefined)), true);
});

test("local HTTP origins cover the served UI and Vite development", () => {
  const origins = [
    "http://localhost:4517",
    "http://127.0.0.1:4517",
    "http://127.0.0.53:5173",
    "http://[::1]:4517",
  ];
  for (const origin of origins) {
    assert.equal(isAllowedWebSocketOrigin(request(origin, new URL(origin).host)), true, origin);
  }
});

test("a matching HTTPS origin is allowed for the reverse-proxied service", () => {
  assert.equal(
    isAllowedWebSocketOrigin(request("https://cinba.example.ts.net", "cinba.example.ts.net")),
    true,
  );
});

test("a browser origin must name the WebSocket request host", () => {
  assert.equal(
    isAllowedWebSocketOrigin(request("https://evil.example", "cinba.example.ts.net")),
    false,
  );
  assert.equal(
    isAllowedWebSocketOrigin(
      request("https://cinba.example.ts.net.evil.example", "cinba.example.ts.net"),
    ),
    false,
  );
});

test("plain HTTP is refused for non-local hosts", () => {
  assert.equal(
    isAllowedWebSocketOrigin(request("http://cinba.example.ts.net", "cinba.example.ts.net")),
    false,
  );
});

test("malformed or incomplete browser origins fail closed", () => {
  assert.equal(isAllowedWebSocketOrigin(request("null", "cinba.example.ts.net")), false);
  assert.equal(
    isAllowedWebSocketOrigin(request("https://cinba.example.ts.net/path", "cinba.example.ts.net")),
    false,
  );
  assert.equal(isAllowedWebSocketOrigin(request("https://cinba.example.ts.net", undefined)), false);
  assert.equal(
    isAllowedWebSocketOrigin(request("ws://cinba.example.ts.net", "cinba.example.ts.net")),
    false,
  );
});
