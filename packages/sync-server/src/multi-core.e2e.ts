import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { temporaryDirectory } from "@cinba/test-support";
import { backupSyncState, restoreSyncState } from "./services/backup-service.ts";
import { resolveEffectiveSettings } from "../../server/src/effective-settings.ts";
import { createSnapshotCache } from "../../server/src/sync/snapshot-cache.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVICE_ENTRY = join(PACKAGE_ROOT, "src", "service-entry.ts");
const CERTIFICATE = readFileSync(join(PACKAGE_ROOT, "src", "fixtures", "localhost-cert.pem"));
const PRIVATE_KEY = readFileSync(join(PACKAGE_ROOT, "src", "fixtures", "localhost-key.pem"));

async function freePort(): Promise<number> {
  const server = createHttpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP port");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

const trustedFetch: typeof fetch = (input, init = {}) =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const request = httpsRequest(
      url,
      {
        method: init.method,
        headers: Object.fromEntries(new Headers(init.headers)),
        ca: CERTIFICATE,
        signal: init.signal ?? undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            let values: string[];
            if (value === undefined) {
              values = [];
            } else if (Array.isArray(value)) {
              values = value;
            } else {
              values = [value];
            }
            for (const item of values) {
              headers.append(name, String(item));
            }
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 500,
              statusText: response.statusMessage,
              headers,
            }),
          );
        });
      },
    );
    request.once("error", reject);
    if (typeof init.body === "string" || init.body instanceof Uint8Array) {
      request.end(init.body);
    } else {
      request.end();
    }
  });

async function waitForHealth(origin: string, output: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await trustedFetch(`${origin}/health`)).ok) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Sync Server did not become healthy: ${output.join("")}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

test("real Sync process preserves multi-Core policy, offline data, revocation, and migration", async (t) => {
  const root = temporaryDirectory("cinba-sync-e2e-", t);
  const sourceState = join(root, "source");
  const restoredState = join(root, "restored");
  const webRoot = join(root, "web");
  const archive = join(root, "sync.backup");
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, "index.html"), "Sync fixture");
  const upstreamPort = await freePort();
  const requests: string[] = [];
  const proxy = createHttpsServer({ cert: CERTIFICATE, key: PRIVATE_KEY }, (incoming, outgoing) => {
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: upstreamPort,
        path: incoming.url,
        method: incoming.method,
        headers: {
          ...incoming.headers,
          host: `127.0.0.1:${upstreamPort}`,
          "x-forwarded-proto": "https",
          "x-forwarded-host": (proxy.address() as { port: number }).port
            ? `localhost:${(proxy.address() as { port: number }).port}`
            : "localhost",
        },
      },
      (response) => {
        requests.push(`${incoming.method} ${incoming.url} ${response.statusCode}`);
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502);
      }
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") {
    throw new Error("expected TLS proxy port");
  }
  const origin = `https://localhost:${proxyAddress.port}`;
  const output: string[] = [];
  let child: ChildProcess | undefined;
  const start = (stateDirectory: string) => {
    const serviceProcess = spawn(process.execPath, [SERVICE_ENTRY], {
      cwd: root,
      env: {
        ...process.env,
        CINBA_SYNC_HOST: "127.0.0.1",
        CINBA_SYNC_PORT: String(upstreamPort),
        CINBA_SYNC_PUBLIC_ORIGIN: origin,
        CINBA_SYNC_STATE_DIR: stateDirectory,
        CINBA_SYNC_WEB_ROOT: webRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    serviceProcess.stdout?.setEncoding("utf8");
    serviceProcess.stderr?.setEncoding("utf8");
    serviceProcess.stdout?.on("data", (text: string) => output.push(text));
    serviceProcess.stderr?.on("data", (text: string) => output.push(text));
    return serviceProcess;
  };

  const modelKey = "seed-model-key-never-log";
  const searchKey = "seed-search-key-never-log";
  const administratorPassword = "administrator-password";
  try {
    child = start(sourceState);
    await waitForHealth(origin, output);
    const setupCode = output.join("").match(/Setup Code: ([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(setupCode);
    const setupResponse = await trustedFetch(`${origin}/api/management/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ version: 1, setupCode, password: administratorPassword }),
    });
    assert.equal(setupResponse.status, 200);
    const setup = (await setupResponse.json()) as { csrfToken: string };
    const cookie = setupResponse.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const fetchWithOrigin: typeof fetch = (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Origin", origin);
      return trustedFetch(input, { ...init, headers });
    };
    const http = new SyncHttpClient(origin, { fetch: fetchWithOrigin });
    const management = new ManagementSyncClient(
      http,
      managementAuthorization(setup.csrfToken, cookie),
    );
    const enrollmentClient = new EnrollmentClient(http);

    const enroll = async (name: string, credentialSource: "local" | "sync") => {
      const pending = await enrollmentClient.create({
        version: 1,
        name,
        platform: "linux",
        appVersion: "1.0.0",
        credentialSource,
      });
      await management.decideEnrollment(pending.enrollmentId, { version: 1, decision: "approve" });
      const result = await enrollmentClient.status(
        pending.enrollmentId,
        enrollmentAuthorization(pending.enrollmentSecret),
      );
      assert.equal(result.status, "approved");
      if (result.status !== "approved") {
        throw new Error("enrollment was not approved");
      }
      return result;
    };
    const ordinary = await enroll("Ordinary Core", "sync");
    const development = await enroll("Development Core", "local");
    await management.putCredential("deepseek", { version: 1, apiKey: modelKey });
    await management.putCredential("exa", { version: 1, apiKey: searchKey });
    await management.updateSettings({
      version: 1,
      baseSettingsRevision: 0,
      settings: {
        version: 1,
        defaultModel: { provider: "deepseek", id: "deepseek-chat" },
        webTools: { searchPrimary: "exa" },
      },
    });
    const ordinaryClient = new CoreSyncClient(http, coreAuthorization(ordinary.coreCredential));
    const developmentClient = new CoreSyncClient(
      http,
      coreAuthorization(development.coreCredential),
    );
    const ordinarySnapshot = await ordinaryClient.snapshot();
    const developmentSnapshot = await developmentClient.snapshot();
    assert.equal(ordinarySnapshot.status, "updated");
    assert.equal(developmentSnapshot.status, "updated");
    if (ordinarySnapshot.status !== "updated" || developmentSnapshot.status !== "updated") {
      throw new Error("expected snapshots");
    }
    assert.deepEqual(ordinarySnapshot.snapshot.credentials, {
      deepseek: modelKey,
      exa: searchKey,
    });
    assert.equal(developmentSnapshot.snapshot.credentials, undefined);

    const updated = await management.updateSettings({
      version: 1,
      baseSettingsRevision: 1,
      settings: {
        version: 1,
        defaultModel: { provider: "deepseek", id: "deepseek-reasoner" },
        webTools: { searchPrimary: "brave" },
      },
    });
    assert.equal(updated.settingsRevision, 2);
    const ordinaryUpdated = await ordinaryClient.snapshot();
    const developmentUpdated = await developmentClient.snapshot();
    assert.equal(
      ordinaryUpdated.status === "updated" && ordinaryUpdated.snapshot.settingsRevision,
      2,
    );
    assert.equal(
      developmentUpdated.status === "updated" && developmentUpdated.snapshot.settingsRevision,
      2,
    );
    if (ordinaryUpdated.status !== "updated" || developmentUpdated.status !== "updated") {
      throw new Error("expected updated snapshots");
    }
    const ordinaryCachePath = join(root, "ordinary", "sync-cache.json");
    const developmentCachePath = join(root, "development", "sync-cache.json");
    createSnapshotCache(ordinaryCachePath).commit(ordinaryUpdated.snapshot, ordinaryUpdated.etag);
    createSnapshotCache(developmentCachePath).commit(
      developmentUpdated.snapshot,
      developmentUpdated.etag,
    );
    assert.equal(
      resolveEffectiveSettings({
        sources: { settings: "sync", credentials: "local" },
        local: { defaultModel: undefined, webTools: { searchPrimary: "auto" } },
        shared: {
          defaultModel: developmentUpdated.snapshot.settings.defaultModel,
          webTools: { searchPrimary: developmentUpdated.snapshot.settings.webTools.searchPrimary },
        },
        override: { webTools: { searchPrimary: "auto" } },
      }).webTools.searchPrimary,
      "auto",
    );

    await stop(child);
    child = undefined;
    assert.equal(
      createSnapshotCache(ordinaryCachePath).get()?.snapshot.credentials?.deepseek,
      modelKey,
    );
    assert.equal(createSnapshotCache(developmentCachePath).get()?.snapshot.credentials, undefined);
    assert.equal(
      createSnapshotCache(developmentCachePath).get()?.snapshot.settings.defaultModel?.id,
      "deepseek-reasoner",
    );
    backupSyncState(sourceState, archive, "one-time-migration-password");

    child = start(sourceState);
    await waitForHealth(origin, output);
    const loginResponse = await trustedFetch(`${origin}/api/management/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ version: 1, password: administratorPassword }),
    });
    const login = (await loginResponse.json()) as { csrfToken: string };
    const loginCookie = loginResponse.headers.get("set-cookie")?.split(";", 1)[0];
    const managementAfterRestart = new ManagementSyncClient(
      http,
      managementAuthorization(login.csrfToken, loginCookie),
    );
    await managementAfterRestart.revokeCore(ordinary.coreId);
    await assert.rejects(ordinaryClient.snapshot(), (error: unknown) => {
      assert.ok(error instanceof SyncClientError);
      assert.equal(error.status, 401);
      return true;
    });
    await stop(child);
    child = undefined;

    restoreSyncState(restoredState, archive, "one-time-migration-password");
    child = start(restoredState);
    await waitForHealth(origin, output);
    const restoredSnapshot = await ordinaryClient.snapshot();
    assert.equal(restoredSnapshot.status, "updated");
    if (restoredSnapshot.status === "updated") {
      assert.equal(restoredSnapshot.snapshot.credentials?.deepseek, modelKey);
    }
    const combinedLogs = `${output.join("")}\n${requests.join("\n")}`;
    assert.equal(combinedLogs.includes(modelKey), false);
    assert.equal(combinedLogs.includes(searchKey), false);
    assert.equal(combinedLogs.includes(administratorPassword), false);
    assert.equal(combinedLogs.includes(ordinary.coreCredential), false);
    assert.equal(combinedLogs.includes(development.coreCredential), false);
  } finally {
    if (child) {
      await stop(child);
    }
    proxy.closeAllConnections();
    proxy.close();
  }
});
