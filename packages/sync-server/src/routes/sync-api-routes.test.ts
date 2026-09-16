import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CoreSyncClient,
  EnrollmentClient,
  ManagementSyncClient,
  SyncClientError,
  SyncHttpClient,
  coreAuthorization,
  enrollmentAuthorization,
  managementAuthorization,
} from "@cinba/sync-client";
import { AdministratorAuthService } from "../services/administrator-auth.ts";
import { createSyncStore } from "../store/sync-store.ts";
import { type SyncAccessLog, createSyncApiHandler } from "./sync-api-routes.ts";

test("typed clients complete enrollment, configuration, synchronization, and revocation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cinba-sync-api-"));
  const store = createSyncStore(directory);
  const setupCode = store.localSetupCode()!;
  const administratorPassword = "integration-password";
  const apiKey = "integration-api-key";
  const replacementKey = "replacement-api-key";
  const logs: SyncAccessLog[] = [];
  let handler!: ReturnType<typeof createSyncApiHandler>;
  const server = createServer((request, response) => void handler(request, response));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("test server did not bind a TCP port");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const administrator = new AdministratorAuthService({
    store,
    origin,
    cookieMode: "loopback-development",
  });
  handler = createSyncApiHandler({ store, administrator, log: (entry) => logs.push(entry) });

  try {
    const setupResponse = await fetch(`${origin}/api/management/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ version: 1, setupCode, password: administratorPassword }),
    });
    assert.equal(setupResponse.status, 200);
    assert.equal(setupResponse.headers.get("cache-control"), "no-store");
    const setup = (await setupResponse.json()) as { csrfToken: string };
    const cookie = setupResponse.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);

    const fetchWithOrigin: typeof fetch = (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Origin", origin);
      return fetch(input, { ...init, headers });
    };
    const http = new SyncHttpClient(origin, {
      allowInsecureLoopback: true,
      fetch: fetchWithOrigin,
    });
    const management = new ManagementSyncClient(
      http,
      managementAuthorization(setup.csrfToken, cookie),
    );
    const enrollments = new EnrollmentClient(http);

    const sharedEnrollment = await enrollments.create({
      version: 1,
      name: "Shared Core",
      platform: "windows",
      appVersion: "0.0.0",
      credentialSource: "sync",
    });
    assert.equal((await management.enrollments()).enrollments.length, 1);
    await management.decideEnrollment(sharedEnrollment.enrollmentId, {
      version: 1,
      decision: "approve",
    });
    const sharedApproval = await enrollments.status(
      sharedEnrollment.enrollmentId,
      enrollmentAuthorization(sharedEnrollment.enrollmentSecret),
    );
    assert.equal(sharedApproval.status, "approved");
    if (sharedApproval.status !== "approved") {
      return;
    }
    const sharedCore = new CoreSyncClient(http, coreAuthorization(sharedApproval.coreCredential));

    assert.deepEqual((await management.credentials()).credentials, []);
    const credentialStatus = await management.putCredential("deepseek", {
      version: 1,
      apiKey,
    });
    assert.deepEqual(credentialStatus.credentials, [
      { version: 1, provider: "deepseek", configured: true },
    ]);
    assert.equal(JSON.stringify(credentialStatus).includes(apiKey), false);
    await management.updateSettings({
      version: 1,
      baseSettingsRevision: 0,
      settings: {
        version: 1,
        defaultModel: { provider: "deepseek", id: "deepseek-chat" },
        webTools: { searchPrimary: "exa" },
      },
    });
    await assert.rejects(
      management.updateSettings({
        version: 1,
        baseSettingsRevision: 0,
        settings: { version: 1, webTools: { searchPrimary: "brave" } },
      }),
      (error: unknown) => {
        assert.ok(error instanceof SyncClientError);
        assert.equal(error.code, "conflict");
        return true;
      },
    );

    const firstSnapshot = await sharedCore.snapshot();
    assert.equal(firstSnapshot.status, "updated");
    if (firstSnapshot.status !== "updated") {
      return;
    }
    assert.deepEqual(firstSnapshot.snapshot.credentials, { deepseek: apiKey });
    assert.deepEqual(await sharedCore.snapshot(firstSnapshot.etag), {
      status: "unchanged",
      etag: firstSnapshot.etag,
    });
    await sharedCore.report({
      version: 1,
      appVersion: "1.0.0",
      capabilities: {
        version: 1,
        providers: [{ id: "deepseek", name: "DeepSeek", authKind: "api-key" }],
        models: [{ provider: "deepseek", id: "deepseek-chat" }],
      },
      currentSyncRevision: firstSnapshot.snapshot.syncRevision,
      lastSyncErrorCode: "previous_failure",
    });
    const sharedCoreView = (await management.cores()).cores.find(
      (core) => core.id === sharedApproval.coreId,
    );
    assert.equal(sharedCoreView?.appVersion, "1.0.0");
    assert.equal(sharedCoreView?.lastSyncErrorCode, "previous_failure");

    const localEnrollment = await enrollments.create({
      version: 1,
      name: "Local Credential Core",
      platform: "linux",
      appVersion: "0.0.0",
      credentialSource: "local",
    });
    await management.decideEnrollment(localEnrollment.enrollmentId, {
      version: 1,
      decision: "approve",
    });
    const localApproval = await enrollments.status(
      localEnrollment.enrollmentId,
      enrollmentAuthorization(localEnrollment.enrollmentSecret),
    );
    assert.equal(localApproval.status, "approved");
    if (localApproval.status !== "approved") {
      return;
    }
    const localCore = new CoreSyncClient(http, coreAuthorization(localApproval.coreCredential));
    const localSnapshot = await localCore.snapshot();
    assert.equal(localSnapshot.status, "updated");
    if (localSnapshot.status === "updated") {
      assert.equal(localSnapshot.snapshot.credentials, undefined);
    }
    const forced = await fetch(`${origin}/api/core/snapshot?includeCredentials=true`, {
      headers: { Authorization: `Bearer ${localApproval.coreCredential}` },
    });
    assert.equal(forced.status, 200);
    assert.equal(forced.headers.get("cache-control"), "no-store");
    assert.equal(
      Object.hasOwn((await forced.json()) as Record<string, unknown>, "credentials"),
      false,
    );
    await localCore.report({
      version: 1,
      appVersion: "2.0.0",
      capabilities: {
        version: 1,
        providers: [],
        models: [{ provider: "openai", id: "local-only" }],
      },
    });
    const catalog = await management.models();
    assert.equal(catalog.models.length, 2);
    assert.ok(catalog.models.every((model) => model.unsupportedCoreIds.length === 1));

    const forbiddenManagement = await fetch(`${origin}/api/management/settings`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${sharedApproval.coreCredential}`,
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: JSON.stringify({
        version: 1,
        baseSettingsRevision: 1,
        settings: { version: 1, webTools: { searchPrimary: "auto" } },
      }),
    });
    assert.equal(forbiddenManagement.status, 401);
    assert.equal(forbiddenManagement.headers.get("cache-control"), "no-store");

    const forgedCapabilities = await fetch(`${origin}/api/core/capabilities`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${localApproval.coreCredential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        appVersion: "2.0.0",
        coreId: sharedApproval.coreId,
        capabilities: { version: 1, providers: [], models: [] },
      }),
    });
    assert.equal(forgedCapabilities.status, 400);

    await management.putCredential("deepseek", { version: 1, apiKey: replacementKey });
    const replaced = await sharedCore.snapshot();
    assert.equal(replaced.status, "updated");
    if (replaced.status === "updated") {
      assert.equal(replaced.snapshot.credentials?.deepseek, replacementKey);
    }
    await management.deleteCredential("deepseek");
    const cleared = await sharedCore.snapshot();
    assert.equal(cleared.status, "updated");
    if (cleared.status === "updated") {
      assert.deepEqual(cleared.snapshot.credentials, {});
    }

    const history = await management.history();
    assert.deepEqual(
      history.entries.map((entry) => entry.settingsRevision),
      [0, 1],
    );
    const rolledBack = await management.rollback({
      version: 1,
      baseSettingsRevision: 1,
      targetSettingsRevision: 0,
    });
    assert.equal(rolledBack.settingsRevision, 2);

    await management.revokeCore(sharedApproval.coreId);
    await assert.rejects(sharedCore.snapshot(), (error: unknown) => {
      assert.ok(error instanceof SyncClientError);
      assert.equal(error.code, "unauthorized");
      return true;
    });
    assert.equal((await localCore.snapshot()).status, "updated");

    const visibleLogs = JSON.stringify(logs);
    for (const secret of [
      setupCode,
      administratorPassword,
      apiKey,
      replacementKey,
      sharedApproval.coreCredential,
      localApproval.coreCredential,
      setup.csrfToken,
    ]) {
      assert.equal(visibleLogs.includes(secret), false);
    }
    assert.ok(
      logs.every(
        (entry) =>
          Object.keys(entry).toSorted().join(",") === "requestId,route,status" &&
          !entry.route.includes(sharedApproval.coreId),
      ),
    );
  } finally {
    server.close();
    await once(server, "close");
    rmSync(directory, { recursive: true, force: true });
  }
});
