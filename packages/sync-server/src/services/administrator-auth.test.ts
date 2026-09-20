import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import { AttemptLimiter } from "../security/rate-limiter.ts";
import { AdministratorSessions } from "../security/sessions.ts";
import { createSyncStore } from "../store/sync-store.ts";
import { AdministratorAuthService, type AuthenticationSuccess } from "./administrator-auth.ts";

function fixture(t: TestContext) {
  const directory = temporaryDirectory("cinba-admin-auth-", t);
  const store = createSyncStore(directory);
  const service = new AdministratorAuthService({
    store,
    origin: "https://sync.example.test",
  });
  return {
    directory,
    store,
    service,
  };
}

function security(overrides: Partial<Parameters<AdministratorAuthService["login"]>[1]> = {}) {
  return {
    origin: "https://sync.example.test",
    clientKey: "test-client",
    ...overrides,
  };
}

function sessionCookie(result: AuthenticationSuccess): string {
  return result.setCookie.split(";", 1)[0]!;
}

test("Setup Code succeeds once, is removed, and cannot revive after restart", async (t) => {
  const files = fixture(t);
  const setupCode = files.store.localSetupCode();
  assert.ok(setupCode);
  assert.equal(
    readFileSync(join(files.directory, "state.json"), "utf8").includes(setupCode),
    false,
  );
  assert.equal(JSON.stringify(files.store.snapshot(true)).includes(setupCode), false);
  const result = await files.service.setup(setupCode, "a-strong-password", security());
  assert.equal(result.ok, true);
  assert.equal(files.store.authenticationState(), "ready");
  assert.equal(files.store.localSetupCode(), undefined);
  assert.deepEqual(await files.service.setup(setupCode, "a-strong-password", security()), {
    ok: false,
    status: 409,
    code: "conflict",
  });

  const restarted = createSyncStore(files.directory);
  assert.equal(restarted.authenticationState(), "ready");
  assert.equal(restarted.localSetupCode(), undefined);
});

test("passwords never land in plaintext and repeated setup uses independent salts", async (t) => {
  const files = fixture(t);
  const password = "same-strong-password";
  await files.service.setup(files.store.localSetupCode()!, password, security());
  const firstDisk = readFileSync(join(files.directory, "state.json"), "utf8");
  const firstHash = (JSON.parse(firstDisk) as { administrator: unknown }).administrator;
  assert.equal(firstDisk.includes(password), false);

  const nextCode = await files.service.resetPasswordLocally();
  await files.service.setup(nextCode, password, security());
  const secondDisk = readFileSync(join(files.directory, "state.json"), "utf8");
  const secondHash = (JSON.parse(secondDisk) as { administrator: unknown }).administrator;
  assert.equal(secondDisk.includes(password), false);
  assert.notDeepEqual(firstHash, secondHash);
});

test("login, logout, expiry, and process-local sessions have distinct states", async (t) => {
  const directory = temporaryDirectory("cinba-admin-auth-", t);
  let now = Date.UTC(2026, 8, 16);
  const store = createSyncStore(directory);
  const sessions = new AdministratorSessions({ lifetimeMs: 1_000, now: () => now });
  const service = new AdministratorAuthService({
    store,
    origin: "https://sync.example.test",
    sessions,
  });
  await service.setup(store.localSetupCode()!, "a-strong-password", security());

  assert.deepEqual(service.login("wrong-password", security()), {
    ok: false,
    status: 401,
    code: "unauthorized",
  });
  const login = service.login("a-strong-password", security());
  assert.equal(login.ok, true);
  if (!login.ok) {
    return;
  }
  const cookie = sessionCookie(login);
  assert.equal(service.status(cookie).state, "authenticated");

  now += 1_001;
  assert.equal(service.status(cookie).state, "ready");

  const next = service.login("a-strong-password", security());
  assert.equal(next.ok, true);
  if (!next.ok) {
    return;
  }
  const nextCookie = sessionCookie(next);
  const logout = service.logout(security({ cookie: nextCookie, csrfToken: next.body.csrfToken }));
  assert.equal(logout.ok, true);
  assert.equal(service.status(nextCookie).state, "ready");

  const restartedService = new AdministratorAuthService({
    store: createSyncStore(directory),
    origin: "https://sync.example.test",
  });
  assert.equal(restartedService.status(nextCookie).state, "ready");
});

test("management writes require matching Origin, Cookie, and CSRF without replay", async (t) => {
  const files = fixture(t);
  const setup = await files.service.setup(
    files.store.localSetupCode()!,
    "a-strong-password",
    security(),
  );
  assert.equal(setup.ok, true);
  if (!setup.ok) {
    return;
  }
  const cookie = sessionCookie(setup);

  assert.equal(files.service.authorizeWrite(security()).ok, false);
  assert.equal(files.service.authorizeWrite(security({ cookie })).ok, false);
  assert.equal(
    files.service.authorizeWrite(
      security({ cookie, csrfToken: setup.body.csrfToken, origin: "https://evil.test" }),
    ).ok,
    false,
  );
  assert.equal(
    files.service.authorizeWrite(security({ cookie, csrfToken: setup.body.csrfToken })).ok,
    true,
  );
  assert.equal(
    files.service.logout(security({ cookie, csrfToken: setup.body.csrfToken })).ok,
    true,
  );
  assert.equal(
    files.service.authorizeWrite(security({ cookie, csrfToken: setup.body.csrfToken })).ok,
    false,
  );
});

test("local password reset invalidates sessions and the old password", async (t) => {
  const files = fixture(t);
  const setup = await files.service.setup(
    files.store.localSetupCode()!,
    "original-password",
    security(),
  );
  assert.equal(setup.ok, true);
  if (!setup.ok) {
    return;
  }
  const oldCookie = sessionCookie(setup);
  const resetCode = await files.service.resetPasswordLocally();

  assert.equal(files.service.status(oldCookie).state, "setup-required");
  const duringReset = files.service.login("original-password", security());
  assert.equal(duringReset.ok, false);
  if (!duringReset.ok) {
    assert.equal(duringReset.code, "conflict");
  }
  assert.equal((await files.service.setup(resetCode, "replacement-password", security())).ok, true);
  assert.equal(files.service.login("original-password", security()).ok, false);
  assert.equal(files.service.login("replacement-password", security()).ok, true);
});

test("failed setup and login attempts are rate limited without retaining input values", async (t) => {
  const directory = temporaryDirectory("cinba-admin-auth-", t);
  const store = createSyncStore(directory);
  const attempts = new AttemptLimiter({ maximumFailures: 2 });
  const service = new AdministratorAuthService({
    store,
    origin: "https://sync.example.test",
    attempts,
  });
  const firstFailure = await service.setup("wrong-one", "a-strong-password", security());
  const secondFailure = await service.setup("wrong-two", "a-strong-password", security());
  assert.equal(firstFailure.ok, false);
  assert.equal(secondFailure.ok, false);
  if (!firstFailure.ok && !secondFailure.ok) {
    assert.equal(firstFailure.status, 401);
    assert.equal(secondFailure.status, 401);
  }
  const blocked = await service.setup(store.localSetupCode()!, "a-strong-password", security());
  assert.deepEqual(blocked, { ok: false, status: 429, code: "rate_limited" });
  assert.doesNotMatch(JSON.stringify(blocked), /wrong-one|wrong-two|a-strong-password/);
});

test("failed login attempts use the same bounded in-memory rate policy", async (t) => {
  const directory = temporaryDirectory("cinba-admin-auth-", t);
  const store = createSyncStore(directory);
  const service = new AdministratorAuthService({
    store,
    origin: "https://sync.example.test",
    attempts: new AttemptLimiter({ maximumFailures: 2 }),
  });
  await service.setup(store.localSetupCode()!, "correct-password", security());
  assert.equal(service.login("wrong-password-1", security()).ok, false);
  assert.equal(service.login("wrong-password-2", security()).ok, false);
  assert.deepEqual(service.login("correct-password", security()), {
    ok: false,
    status: 429,
    code: "rate_limited",
  });
});

test("cookie security is strict in deployment and explicitly relaxed only for loopback", async (t) => {
  const secureFiles = fixture(t);
  const developmentDirectory = temporaryDirectory("cinba-admin-auth-", t);
  const secure = await secureFiles.service.setup(
    secureFiles.store.localSetupCode()!,
    "a-strong-password",
    security(),
  );
  assert.equal(secure.ok, true);
  if (secure.ok) {
    assert.match(secure.setCookie, /HttpOnly/);
    assert.match(secure.setCookie, /SameSite=Strict/);
    assert.match(secure.setCookie, /Path=\/api\/management/);
    assert.match(secure.setCookie, /Secure/);
  }

  const developmentStore = createSyncStore(developmentDirectory);
  const development = new AdministratorAuthService({
    store: developmentStore,
    origin: "http://127.0.0.1:9000",
    cookieMode: "loopback-development",
  });
  const result = await development.setup(developmentStore.localSetupCode()!, "a-strong-password", {
    origin: "http://127.0.0.1:9000",
    clientKey: "local",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.doesNotMatch(result.setCookie, /; Secure/);
  }
  assert.throws(
    () =>
      new AdministratorAuthService({
        store: developmentStore,
        origin: "http://192.168.1.10:9000",
        cookieMode: "loopback-development",
      }),
    /loopback/,
  );
});
