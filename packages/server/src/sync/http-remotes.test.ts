import assert from "node:assert/strict";
import test from "node:test";
import { SyncClientError } from "@cinba/sync-client";
import { revokeCoreSyncAccess } from "./http-remotes.ts";

test("disconnect accepts confirmed or already-completed remote revocation", async () => {
  const calls: string[] = [];
  await revokeCoreSyncAccess(
    "https://sync.example.test",
    "credential",
    (serverUrl, credential) => ({
      revoke: async () => {
        calls.push(`${serverUrl}:${credential}`);
      },
    }),
  );
  assert.deepEqual(calls, ["https://sync.example.test:credential"]);

  await revokeCoreSyncAccess("https://sync.example.test", "revoked", () => ({
    revoke: async () => {
      throw new SyncClientError({ kind: "http", message: "unauthorized", status: 401 });
    },
  }));
});

test("disconnect preserves local authority when remote revocation is unconfirmed", async () => {
  const unavailable = new SyncClientError({
    kind: "transport",
    message: "Sync Server is unreachable",
    retryable: true,
  });
  await assert.rejects(
    revokeCoreSyncAccess("https://sync.example.test", "credential", () => ({
      revoke: async () => {
        throw unavailable;
      },
    })),
    (error: unknown) => error === unavailable,
  );
});
