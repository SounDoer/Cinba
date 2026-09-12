import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { DeploymentStatus } from "@cinba/deploy";
import { createDeploymentStatusHandler } from "./deployment-status.ts";

const STATUS: DeploymentStatus = {
  version: 1,
  phase: "checking",
  updatedAt: "2026-09-13T12:34:56.000Z",
  targetRevision: "abcdef1234567890abcdef1234567890abcdef12",
  runningRevision: "1234567890abcdef1234567890abcdef12345678",
};

async function withHandler(
  readStatus: () => Promise<DeploymentStatus | undefined>,
  exercise: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const handler = createDeploymentStatusHandler({
    statusPath: "/home/cinba/.cinba/deployment.json",
    readStatus,
  });
  const server = createServer((request, response) => {
    void handler(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    await exercise(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("GET /deployment-status exposes only the validated deployment snapshot", async () => {
  await withHandler(
    async () => STATUS,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/deployment-status`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), STATUS);

      const missing = await fetch(`${baseUrl}/elsewhere`);
      assert.equal(missing.status, 404);

      const wrongMethod = await fetch(`${baseUrl}/deployment-status`, { method: "POST" });
      assert.equal(wrongMethod.status, 405);
      assert.equal(wrongMethod.headers.get("allow"), "GET");
    },
  );
});

test("a missing deployment file is reported without inventing a phase", async () => {
  await withHandler(
    async () => undefined,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/deployment-status`);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), {
        status: "unavailable",
        reason: "not_configured",
      });
    },
  );
});

test("an unreadable deployment status fails closed without leaking the error", async () => {
  await withHandler(
    async () => {
      throw new Error("secret path and command output");
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/deployment-status`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { status: "unavailable", reason: "invalid" });
    },
  );
});
