import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import { beginManagedCoreSyncEnrollment } from "./core-service-control.ts";

test("local Sync enrollment uses a proven manager-owned Core", async (t) => {
  const root = temporaryDirectory("cinba-core-sync-enrollment-", t);
  const config = {
    baseUrl: "http://127.0.0.1:4517/",
    runtimePath: join(root, "runtime.json"),
    controlPath: join(root, "control.json"),
  };
  await writeFile(
    config.controlPath,
    JSON.stringify({ pid: 123, repositoryRoot: join(root, "payload"), token: "secret" }),
  );
  const receipt = {
    enrollmentId: "enrollment-id",
    enrollmentSecret: "enrollment-secret",
    expiresAt: "2026-09-21T12:00:00.000Z",
    settings: { version: 1 as const, webTools: { searchPrimary: "auto" as const } },
  };
  assert.deepEqual(
    await beginManagedCoreSyncEnrollment(config, "http://127.0.0.1:4518", {
      requestStatus: async (_baseUrl, token) => {
        assert.equal(token, "secret");
        return {
          status: "ok",
          lifetime: "on-demand",
          pid: 123,
          clientCount: 0,
          safeToStop: true,
          draining: false,
        };
      },
      requestEnrollment: async (_baseUrl, token, serverUrl) => {
        assert.equal(token, "secret");
        assert.equal(serverUrl, "http://127.0.0.1:4518");
        return receipt;
      },
    }),
    receipt,
  );
});

test("local Sync enrollment does not reach a mismatched Core", async (t) => {
  const root = temporaryDirectory("cinba-core-sync-unowned-", t);
  const config = {
    baseUrl: "http://127.0.0.1:4517/",
    runtimePath: join(root, "runtime.json"),
    controlPath: join(root, "control.json"),
  };
  await writeFile(config.controlPath, JSON.stringify({ pid: 123, token: "secret" }));
  let enrollments = 0;
  await assert.rejects(
    beginManagedCoreSyncEnrollment(config, "http://127.0.0.1:4518", {
      requestStatus: async () => ({
        status: "ok",
        lifetime: "persistent",
        pid: 456,
        clientCount: 0,
        safeToStop: true,
        draining: false,
      }),
      requestEnrollment: async () => {
        enrollments += 1;
        return undefined;
      },
    }),
    /not owned/,
  );
  assert.equal(enrollments, 0);
});
