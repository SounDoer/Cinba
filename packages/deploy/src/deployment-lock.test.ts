import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithDeploymentLock } from "./deployment-lock.ts";

const OPTIONS = {
  lockPath: "/home/cinba/.cinba/deployment.lock",
  scriptPath: "/home/cinba/current/packages/deploy/src/deployment-cli.ts",
  nodePath: "/usr/bin/node",
};

test("flock owns the lock for the entire deployment child process", async () => {
  let invocation: { command: string; args: string[] } | undefined;
  assert.equal(
    await runWithDeploymentLock(OPTIONS, async (command, args) => {
      invocation = { command, args };
      return 0;
    }),
    "completed",
  );
  assert.deepEqual(invocation, {
    command: "flock",
    args: [
      "--exclusive",
      "--nonblock",
      "--conflict-exit-code",
      "75",
      "--",
      OPTIONS.lockPath,
      OPTIONS.nodePath,
      OPTIONS.scriptPath,
    ],
  });
});

test("lock contention is quiet but a deployment failure is not", async () => {
  assert.equal(await runWithDeploymentLock(OPTIONS, async () => 75), "busy");
  await assert.rejects(
    runWithDeploymentLock(OPTIONS, async () => 1),
    /exited with code 1/,
  );
});
