import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import { createAdministratorAuthHandler } from "./administrator-auth-routes.ts";
import { AdministratorAuthService } from "../services/administrator-auth.ts";
import { createSyncStore } from "../store/sync-store.ts";

test("administrator HTTP routes distinguish setup, authenticated, logout, and replay", async (t) => {
  const directory = temporaryDirectory("cinba-admin-routes-", t);
  const store = createSyncStore(directory);
  let handler!: ReturnType<typeof createAdministratorAuthHandler>;
  const server = createServer((request, response) => {
    void handler(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404).end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("test server did not bind a TCP port");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  handler = createAdministratorAuthHandler(
    new AdministratorAuthService({
      store,
      origin,
      cookieMode: "loopback-development",
    }),
  );

  try {
    const initial = await fetch(`${origin}/api/management/auth/status`);
    assert.deepEqual(await initial.json(), { version: 1, state: "setup-required" });
    assert.equal(initial.headers.get("cache-control"), "no-store");

    const rejected = await fetch(`${origin}/api/management/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.test" },
      body: JSON.stringify({
        version: 1,
        setupCode: store.localSetupCode(),
        password: "route-test-password",
      }),
    });
    assert.equal(rejected.status, 403);
    const rejectedBody = JSON.stringify(await rejected.json());
    assert.doesNotMatch(rejectedBody, /route-test-password/);
    assert.doesNotMatch(rejectedBody, new RegExp(store.localSetupCode()!));

    const setup = await fetch(`${origin}/api/management/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        version: 1,
        setupCode: store.localSetupCode(),
        password: "route-test-password",
      }),
    });
    assert.equal(setup.status, 200);
    const setupBody = (await setup.json()) as { csrfToken: string; state: string };
    const cookie = setup.headers.get("set-cookie")?.split(";", 1)[0];
    assert.equal(setupBody.state, "authenticated");
    assert.ok(cookie);
    assert.match(setup.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict/);
    assert.doesNotMatch(setup.headers.get("set-cookie") ?? "", /; Secure/);

    const restored = await fetch(`${origin}/api/management/auth/status`, {
      headers: { Cookie: cookie },
    });
    assert.deepEqual(await restored.json(), {
      version: 1,
      state: "authenticated",
      csrfToken: setupBody.csrfToken,
    });

    const missingCsrf = await fetch(`${origin}/api/management/auth/logout`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
    });
    assert.equal(missingCsrf.status, 403);

    const logout = await fetch(`${origin}/api/management/auth/logout`, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "X-Cinba-CSRF": setupBody.csrfToken,
      },
    });
    assert.equal(logout.status, 200);

    const replay = await fetch(`${origin}/api/management/auth/logout`, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "X-Cinba-CSRF": setupBody.csrfToken,
      },
    });
    assert.equal(replay.status, 401);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("administrator HTTP routes reject malformed and extra secret fields", async (t) => {
  const directory = temporaryDirectory("cinba-admin-routes-", t);
  const store = createSyncStore(directory);
  const service = new AdministratorAuthService({
    store,
    origin: "https://sync.example.test",
  });
  const handler = createAdministratorAuthHandler(service);
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("test server did not bind a TCP port");
  }
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/management/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://sync.example.test" },
      body: JSON.stringify({
        version: 1,
        password: "password-seed-value",
        apiKey: "api-key-seed-value",
      }),
    });
    assert.equal(response.status, 400);
    const body = JSON.stringify(await response.json());
    assert.doesNotMatch(body, /password-seed-value|api-key-seed-value/);
  } finally {
    server.close();
    await once(server, "close");
  }
});
