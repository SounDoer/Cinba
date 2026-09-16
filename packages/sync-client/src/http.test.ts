import assert from "node:assert/strict";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import {
  AdministratorSyncClient,
  CoreSyncClient,
  EnrollmentClient,
  ManagementSyncClient,
  SyncClientError,
  SyncHttpClient,
  coreAuthorization,
  enrollmentAuthorization,
  managementAuthorization,
  normalizeSyncServerUrl,
} from "./index.ts";

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

async function fixture(handler: Handler): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => {
      response.destroy();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("fixture did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

function json(response: ServerResponse, status: number, body: unknown, extra = {}): void {
  response.writeHead(status, { "Content-Type": "application/json", ...extra });
  response.end(JSON.stringify(body));
}

test("Sync Server URLs are normalized to a secure root origin", () => {
  assert.equal(normalizeSyncServerUrl("https://sync.example.test/"), "https://sync.example.test");
  assert.equal(
    normalizeSyncServerUrl("http://127.0.0.1:9000", { allowInsecureLoopback: true }),
    "http://127.0.0.1:9000",
  );
  for (const url of [
    "http://sync.example.test",
    "https://user@sync.example.test",
    "https://sync.example.test/path",
    "https://sync.example.test?token=secret",
    "https://sync.example.test#fragment",
  ]) {
    assert.throws(() => normalizeSyncServerUrl(url), SyncClientError);
  }
  assert.throws(
    () =>
      normalizeSyncServerUrl("http://192.168.1.5", {
        allowInsecureLoopback: true,
      }),
    /HTTPS/,
  );
});

test("management and Core authorization are distinct compile-time capabilities", () => {
  const http = new SyncHttpClient("https://sync.example.test");
  const management = managementAuthorization("csrf");
  const core = coreAuthorization("core-token");
  assert.ok(new ManagementSyncClient(http, management));
  assert.ok(new CoreSyncClient(http, core));
  // These assignments deliberately exercise only the compile-time boundary.
  // @ts-expect-error Management authorization cannot authenticate a Core client.
  const wronglyAuthorizedCore = new CoreSyncClient(http, management);
  // @ts-expect-error Core authorization cannot authenticate a management client.
  const wronglyAuthorizedManagement = new ManagementSyncClient(http, core);
  assert.ok(wronglyAuthorizedCore);
  assert.ok(wronglyAuthorizedManagement);
});

test("the HTTP client sends JSON and validates a parsed response", async () => {
  let contentType: string | undefined;
  const server = await fixture(async (request, response) => {
    contentType = request.headers["content-type"];
    for await (const chunk of request) {
      // Drain the request body so the connection can be reused safely.
      void chunk;
    }
    json(response, 200, { version: 1, accepted: true });
  });
  try {
    const client = new SyncHttpClient(server.url, { allowInsecureLoopback: true });
    const result = await client.json({
      path: "/api/core/capabilities",
      method: "PUT",
      body: { version: 1 },
      parser: (value) => value,
    });
    assert.equal(result.status, "ok");
    assert.equal(contentType, "application/json");
  } finally {
    await server.close();
  }
});

test("timeouts and caller aborts become redacted transport errors", async () => {
  const server = await fixture((_request, response) => {
    setTimeout(() => json(response, 200, { version: 1 }), 100);
  });
  try {
    const timed = new SyncHttpClient(server.url, {
      allowInsecureLoopback: true,
      timeoutMs: 10,
    });
    await assert.rejects(timed.json({ path: "/slow", parser: (value) => value }), /timed out/);

    const controller = new AbortController();
    const waiting = new SyncHttpClient(server.url, {
      allowInsecureLoopback: true,
      timeoutMs: 1_000,
    }).json({ path: "/slow", parser: (value) => value, signal: controller.signal });
    controller.abort("caller-secret-reason");
    await assert.rejects(waiting, (error: unknown) => {
      assert.match(String(error), /aborted/);
      assert.doesNotMatch(String(error), /caller-secret-reason/);
      return true;
    });
  } finally {
    await server.close();
  }
});

test("non-JSON and oversized responses fail before schema parsing", async () => {
  let mode: "text" | "large" = "text";
  const server = await fixture((_request, response) => {
    if (mode === "text") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("not json");
      return;
    }
    json(response, 200, { value: "x".repeat(100) });
  });
  try {
    const client = new SyncHttpClient(server.url, {
      allowInsecureLoopback: true,
      maxResponseBytes: 32,
    });
    await assert.rejects(client.json({ path: "/value", parser: (value) => value }), /not JSON/);
    mode = "large";
    await assert.rejects(client.json({ path: "/value", parser: (value) => value }), /size limit/);
  } finally {
    await server.close();
  }
});

test("invalid JSON errors do not retain response plaintext", async () => {
  const secret = "seed-response-secret";
  const server = await fixture((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(`{${secret}`);
  });
  try {
    const client = new SyncHttpClient(server.url, { allowInsecureLoopback: true });
    await assert.rejects(
      client.json({ path: "/broken", parser: (value) => value }),
      (error: unknown) => {
        assert.ok(error instanceof SyncClientError);
        assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, new RegExp(secret));
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("structured HTTP errors expose only safe status and code", async () => {
  const responseSecret = "response-secret-value";
  const requestSecret = "request-secret-value";
  const server = await fixture((_request, response) => {
    json(response, 409, {
      version: 1,
      error: { code: "conflict", message: responseSecret, retryable: false },
    });
  });
  try {
    const client = new SyncHttpClient(server.url, { allowInsecureLoopback: true });
    await assert.rejects(
      client.json({
        path: "/conflict",
        headers: { Authorization: `Bearer ${requestSecret}` },
        parser: (value) => value,
      }),
      (error: unknown) => {
        assert.ok(error instanceof SyncClientError);
        assert.equal(error.status, 409);
        assert.equal(error.code, "conflict");
        const visible = `${String(error)} ${JSON.stringify(error)}`;
        assert.doesNotMatch(visible, new RegExp(responseSecret));
        assert.doesNotMatch(visible, new RegExp(requestSecret));
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("sensitive responses require an explicit no-store policy", async () => {
  let noStore = false;
  const server = await fixture((_request, response) => {
    json(response, 200, { value: true }, noStore ? { "Cache-Control": "private, no-store" } : {});
  });
  try {
    const client = new SyncHttpClient(server.url, { allowInsecureLoopback: true });
    await assert.rejects(
      client.json({ path: "/secret", parser: (value) => value, sensitive: true }),
      /no-store/,
    );
    noStore = true;
    assert.equal(
      (await client.json({ path: "/secret", parser: (value) => value, sensitive: true })).status,
      "ok",
    );
  } finally {
    await server.close();
  }
});

test("conditional Snapshot returns unchanged without parsing a body", async () => {
  let receivedEtag: string | undefined;
  const server = await fixture((request, response) => {
    receivedEtag = request.headers["if-none-match"];
    response.writeHead(304, {
      "Cache-Control": "no-store",
      ETag: '"revision-7"',
      "Content-Type": "text/plain",
    });
    response.end("this is deliberately not a Snapshot");
  });
  try {
    const http = new SyncHttpClient(server.url, { allowInsecureLoopback: true });
    const client = new CoreSyncClient(http, coreAuthorization("core-secret"));
    assert.deepEqual(await client.snapshot('"revision-7"'), {
      status: "unchanged",
      etag: '"revision-7"',
    });
    assert.equal(receivedEtag, '"revision-7"');
  } finally {
    await server.close();
  }
});

test("typed clients keep management, enrollment, and Core authorization on separate routes", async () => {
  const observed: Array<{
    path: string;
    authorization?: string;
    csrf?: string;
    cookie?: string;
  }> = [];
  const server = await fixture((request, response) => {
    observed.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
      csrf: request.headers["x-cinba-csrf"] as string | undefined,
      cookie: request.headers.cookie,
    });
    if (request.url === "/api/management/settings") {
      json(response, 200, {
        version: 1,
        settingsRevision: 1,
        syncRevision: 1,
        settings: { version: 1, webTools: { searchPrimary: "auto" } },
      });
      return;
    }
    if (request.url === "/api/management/auth/status") {
      json(response, 200, { version: 1, state: "setup-required" }, { "Cache-Control": "no-store" });
      return;
    }
    if (request.url === "/api/core/enrollments") {
      json(
        response,
        200,
        {
          version: 1,
          enrollmentId: "enrollment-1",
          enrollmentSecret: "enrollment-secret",
          expiresAt: "2026-09-16T00:00:00.000Z",
        },
        { "Cache-Control": "no-store" },
      );
      return;
    }
    if (request.url === "/api/core/enrollments/enrollment-1") {
      json(response, 200, { version: 1, status: "pending" }, { "Cache-Control": "no-store" });
      return;
    }
    json(response, 200, { version: 1, accepted: true });
  });
  try {
    const http = new SyncHttpClient(server.url, { allowInsecureLoopback: true });
    const management = new ManagementSyncClient(
      http,
      managementAuthorization("csrf-token", "session=session-token"),
    );
    const enrollment = new EnrollmentClient(http);
    const core = new CoreSyncClient(http, coreAuthorization("core-token"));

    assert.equal((await new AdministratorSyncClient(http).status()).state, "setup-required");
    await management.settings();
    const created = await enrollment.create({
      version: 1,
      name: "Studio",
      platform: "windows",
      appVersion: "0.0.0",
      credentialSource: "sync",
    });
    await enrollment.status(
      created.enrollmentId,
      enrollmentAuthorization(created.enrollmentSecret),
    );
    await core.report({
      version: 1,
      appVersion: "0.0.0",
      capabilities: { version: 1, providers: [], models: [] },
    });

    assert.deepEqual(observed, [
      {
        path: "/api/management/auth/status",
        authorization: undefined,
        csrf: undefined,
        cookie: undefined,
      },
      {
        path: "/api/management/settings",
        authorization: undefined,
        csrf: "csrf-token",
        cookie: "session=session-token",
      },
      {
        path: "/api/core/enrollments",
        authorization: undefined,
        csrf: undefined,
        cookie: undefined,
      },
      {
        path: "/api/core/enrollments/enrollment-1",
        authorization: "Enrollment enrollment-secret",
        csrf: undefined,
        cookie: undefined,
      },
      {
        path: "/api/core/capabilities",
        authorization: "Bearer core-token",
        csrf: undefined,
        cookie: undefined,
      },
    ]);
  } finally {
    await server.close();
  }
});
