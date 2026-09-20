import assert from "node:assert/strict";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import {
  acquireProductUpdateLease,
  claimTransferredProductUpdateLease,
  runWithProductUpdateLease,
} from "./update-lock.ts";

test("one update lease covers asynchronous confirmation and installation", async (t) => {
  const root = temporaryDirectory("cinba-update-lease-", t);
  let continueFirst: () => void = () => undefined;
  const confirmation = new Promise<void>((resolve) => {
    continueFirst = resolve;
  });
  let entered: () => void = () => undefined;
  const firstEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const calls: string[] = [];
  const first = runWithProductUpdateLease(root, async () => {
    calls.push("first:confirm");
    entered();
    await confirmation;
    calls.push("first:install");
  });
  await firstEntered;
  await assert.rejects(
    runWithProductUpdateLease(root, async () => {
      calls.push("second:install");
    }),
    /another Cinba update operation is active/,
  );
  continueFirst();
  await first;
  assert.deepEqual(calls, ["first:confirm", "first:install"]);
});

test("a transferred lease remains continuously exclusive until the helper releases it", async (t) => {
  const root = temporaryDirectory("cinba-update-transfer-", t);
  const parent = await acquireProductUpdateLease(root, { processId: 111 });
  await parent.transferTo(222);
  await assert.rejects(
    acquireProductUpdateLease(root, {
      processId: 333,
      processIsAlive: () => true,
    }),
    /another Cinba update operation is active/,
  );

  const helper = await claimTransferredProductUpdateLease(root, parent.token, {
    processId: 222,
  });
  await parent.waitForClaim(222);
  await parent.release();
  await assert.rejects(
    acquireProductUpdateLease(root, {
      processId: 333,
      processIsAlive: () => true,
    }),
    /another Cinba update operation is active/,
  );

  await helper.release();
  const competitor = await acquireProductUpdateLease(root, { processId: 333 });
  await competitor.release();
});

test("runWithProductUpdateLease preserves operation failure when release also fails", async () => {
  const operationError = new Error("operation failed");
  const releaseError = new Error("release failed");
  await assert.rejects(
    runWithProductUpdateLease(
      "C:\\state",
      async () => {
        throw operationError;
      },
      {
        acquire: async () => ({
          stateDirectory: "C:\\state",
          token: "token",
          transferTo: async () => undefined,
          waitForClaim: async () => undefined,
          cancelTransfer: async () => undefined,
          release: async () => {
            throw releaseError;
          },
        }),
      },
    ),
    (error) =>
      error instanceof AggregateError &&
      error.cause === operationError &&
      error.errors[0] === operationError &&
      error.errors[1] === releaseError,
  );
});

test("runWithProductUpdateLease surfaces release failure after successful operation", async () => {
  const releaseError = new Error("release failed");
  await assert.rejects(
    runWithProductUpdateLease("C:\\state", async () => "done", {
      acquire: async () => ({
        stateDirectory: "C:\\state",
        token: "token",
        transferTo: async () => undefined,
        waitForClaim: async () => undefined,
        cancelTransfer: async () => undefined,
        release: async () => {
          throw releaseError;
        },
      }),
    }),
    (error) => error === releaseError,
  );
});
