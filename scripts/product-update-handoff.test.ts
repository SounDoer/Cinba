import assert from "node:assert/strict";
import { access, mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ProductPaths, ProductUpdateLease, UpdateHandoff } from "@cinba/installer";
import { removeTemporaryDirectory, temporaryDirectory } from "@cinba/test-support";
import {
  beginForegroundUpdateHandoff,
  cleanupCopiedUpdateHelper,
  createUpdateRestartCommand,
  launchForegroundUpdateHandoff,
  restartUpdateSurface,
  runUpdateHandoffWorkerOperation,
  waitForProcessExit,
} from "./product-update.ts";

const leaseToken = "11111111-1111-4111-8111-111111111111";

function handoff(surface: "desktop" | "tui" = "desktop"): UpdateHandoff {
  return {
    schemaVersion: 1,
    id: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-09-18T08:00:00.000Z",
    surface,
    blockingProcessId: 456,
    candidate: {
      version: "0.2.0",
      revision: "a".repeat(40),
      target: "windows-x64",
      artifactPath: resolve("cache", "Cinba.exe"),
      size: 42,
      sha256: "b".repeat(64),
      releaseUrl: "https://github.com/SounDoer/Cinba/releases/tag/v0.2.0",
    },
    restart: surface === "desktop" ? {} : { workingDirectory: resolve("project") },
    leaseToken,
  };
}

function lease(calls: unknown[]): ProductUpdateLease {
  return {
    stateDirectory: resolve("state"),
    token: leaseToken,
    transferTo: async (processId) => {
      calls.push(["transfer", processId]);
    },
    waitForClaim: async (processId) => {
      calls.push(["claimed", processId]);
    },
    cancelTransfer: async (processId) => {
      calls.push(["cancel", processId]);
    },
    release: async () => undefined,
  };
}

test("foreground handoff writes private state and passes no candidate or token in argv", async () => {
  const calls: unknown[] = [];
  const updateHandoff = handoff();
  await launchForegroundUpdateHandoff({
    launcherPath: resolve("bin", "cinba.exe"),
    stateDirectory: resolve("state"),
    handoff: updateHandoff,
    lease: lease(calls),
    parentProcessId: 123,
    platform: "win32",
    makeTemporaryDirectory: async () => resolve("temp", "handoff"),
    writeHandoff: async (_stateDirectory, value) => {
      calls.push(["write", value.id]);
    },
    copyFile: async (source, destination) => {
      calls.push(["copy", source, destination]);
    },
    startDetached: async (executable, arguments_) => {
      calls.push(["spawn", executable, arguments_]);
      return { processId: 789, terminate: async () => undefined };
    },
  });
  const helper = resolve("temp", "handoff", "cinba-update-helper.exe");
  assert.deepEqual(calls, [
    ["write", updateHandoff.id],
    ["copy", resolve("bin", "cinba.exe"), helper],
    ["spawn", helper, ["__update-handoff-helper", "123"]],
    ["transfer", 789],
    ["claimed", 789],
  ]);
  assert.equal(JSON.stringify(calls).includes(leaseToken), false);
  assert.equal(JSON.stringify(calls).includes(updateHandoff.candidate.sha256), false);
});

test("begin handoff rejects a blocking PID that is not alive before taking the lease", async () => {
  let acquired = false;
  await assert.rejects(
    beginForegroundUpdateHandoff({
      platform: "win32",
      paths: {
        stateDirectory: resolve("state"),
        launcherPath: resolve("bin", "cinba.exe"),
      } as ProductPaths,
      target: "windows-x64",
      surface: "desktop",
      blockingProcessId: 456,
      expectedVersion: "0.2.0",
      processIsAlive: () => false,
      acquireLease: async () => {
        acquired = true;
        return lease([]);
      },
      readState: async () => assert.fail("ready state must not be read"),
      launch: async () => assert.fail("helper must not launch"),
    }),
    /blocking process is not running/,
  );
  assert.equal(acquired, false);
});

test("begin handoff reads the ready candidate while holding the full lease", async () => {
  const calls: string[] = [];
  const updateLease = lease([]);
  const updateHandoff = handoff("tui");
  await beginForegroundUpdateHandoff({
    platform: "win32",
    paths: {
      stateDirectory: resolve("state"),
      launcherPath: resolve("bin", "cinba.exe"),
    } as ProductPaths,
    target: "windows-x64",
    surface: "tui",
    blockingProcessId: 456,
    expectedVersion: updateHandoff.candidate.version,
    workingDirectory: (updateHandoff.restart as { workingDirectory: string }).workingDirectory,
    processIsAlive: () => true,
    now: () => new Date(updateHandoff.createdAt),
    acquireLease: async () => {
      calls.push("acquire");
      return {
        ...updateLease,
        release: async () => {
          calls.push("release-parent");
        },
      };
    },
    reapClaimed: async (_stateDirectory, options) => {
      calls.push(`scan:${options.currentLeaseToken}`);
      return {
        removed: [],
        retained: ["33333333-3333-4333-8333-333333333333"],
        warnings: ["retained unsafe test record"],
      };
    },
    reportHandoffRecovery: (warning) => {
      calls.push(`warning:${warning}`);
    },
    readState: async () => {
      calls.push("ready");
      return {
        schemaVersion: 1,
        phase: "ready",
        currentVersion: "0.1.0",
        checkedAt: updateHandoff.createdAt,
        candidate: updateHandoff.candidate,
        failure: null,
      };
    },
    launch: async ({ handoff: launched, writeHandoff }) => {
      calls.push("launch");
      assert.deepEqual(launched.candidate, updateHandoff.candidate);
      assert.equal(launched.leaseToken, leaseToken);
      assert.equal(typeof writeHandoff, "function");
    },
  });
  assert.deepEqual(calls, [
    "acquire",
    `scan:${leaseToken}`,
    "warning:retained fresh claimed update handoff claimed-33333333-3333-4333-8333-333333333333.json",
    "warning:retained unsafe test record",
    "ready",
    "launch",
    "release-parent",
  ]);
});

test("begin handoff rejects a changed ready version while holding the lease", async () => {
  const calls: string[] = [];
  const updateHandoff = handoff("desktop");
  await assert.rejects(
    beginForegroundUpdateHandoff({
      platform: "win32",
      paths: {
        stateDirectory: resolve("state"),
        launcherPath: resolve("bin", "cinba.exe"),
      } as ProductPaths,
      target: "windows-x64",
      surface: "desktop",
      blockingProcessId: 456,
      expectedVersion: "0.1.9",
      processIsAlive: () => true,
      acquireLease: async () => ({
        ...lease(calls),
        release: async () => {
          calls.push("release-parent");
        },
      }),
      reapClaimed: async () => ({ removed: [], retained: [], warnings: [] }),
      readState: async () => ({
        schemaVersion: 1,
        phase: "ready",
        currentVersion: "0.1.0",
        checkedAt: updateHandoff.createdAt,
        candidate: updateHandoff.candidate,
        failure: null,
      }),
      launch: async () => {
        calls.push("launch");
      },
    }),
    /expected version 0\.1\.9/,
  );
  assert.deepEqual(calls, ["release-parent"]);
});

test("failed transfer terminates helper and removes handoff, temp, and lease", async () => {
  const calls: unknown[] = [];
  const original = new Error("transfer failed");
  const updateLease = lease(calls);
  updateLease.transferTo = async () => {
    calls.push("transfer");
    throw original;
  };
  await assert.rejects(
    launchForegroundUpdateHandoff({
      launcherPath: resolve("bin", "cinba"),
      stateDirectory: resolve("state"),
      handoff: handoff(),
      lease: updateLease,
      parentProcessId: 123,
      platform: "linux",
      makeTemporaryDirectory: async () => resolve("temp", "handoff"),
      writeHandoff: async () => {
        calls.push("write");
      },
      copyFile: async () => {
        calls.push("copy");
      },
      makeExecutable: async () => {
        calls.push("chmod");
      },
      startDetached: async () => ({
        processId: 789,
        terminate: async () => {
          calls.push("terminate");
        },
      }),
      removeHandoff: async () => {
        calls.push("remove-handoff");
      },
      removeTemporaryDirectory: async () => {
        calls.push("remove-temp");
      },
    }),
    (error) => error === original,
  );
  assert.deepEqual(calls, [
    "write",
    "copy",
    "chmod",
    "transfer",
    "terminate",
    ["cancel", 789],
    "remove-handoff",
    "remove-temp",
  ]);
});

test("helper cleanup removes only an exact helper in a direct mkdtemp child", async (t) => {
  const directory = temporaryDirectory("cinba-update-", t);
  const helper = join(directory, "cinba-update-helper");
  await writeFile(helper, "helper");
  await cleanupCopiedUpdateHelper({
    platform: "linux",
    helperPath: helper,
  });
  await assert.rejects(() => access(directory), { code: "ENOENT" });
});

test("helper cleanup rejects exact-looking files in arbitrary directories", async (t) => {
  const directory = temporaryDirectory("not-cinba-", t);
  const helper = join(directory, "cinba-update-helper");
  await writeFile(helper, "helper");
  await assert.rejects(
    () =>
      cleanupCopiedUpdateHelper({
        platform: "linux",
        helperPath: helper,
      }),
    /not a safe Cinba update helper/,
  );
  await access(helper);
});

test("helper cleanup refuses a symlinked temp directory without following it", async (t) => {
  // The link is registered before its target so that it is removed first. A
  // junction whose target is already gone cannot be removed on Windows at all,
  // and its parent then stays non-empty forever.
  const linked = temporaryDirectory("cinba-update-", t);
  const outsideRoot = temporaryDirectory("cinba-outside-", t);
  const outside = join(outsideRoot, "target");
  await mkdir(outside);
  await removeTemporaryDirectory(linked);
  await writeFile(join(outside, "cinba-update-helper"), "outside");
  await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    () =>
      cleanupCopiedUpdateHelper({
        platform: "linux",
        helperPath: join(linked, "cinba-update-helper"),
      }),
    /symbolic link/,
  );
  await access(join(outside, "cinba-update-helper"));
});

test("worker waits for launcher then blocking surface before installation", async () => {
  const calls: string[] = [];
  await runUpdateHandoffWorkerOperation({
    parentProcessId: 123,
    claimHandoff: async () => {
      calls.push("claim-handoff");
      return handoff();
    },
    validateHandoff: async () => {
      calls.push("validate");
    },
    claimLease: async () => {
      calls.push("claim-lease");
      return async () => {
        calls.push("release");
      };
    },
    waitForProcess: async (processId) => {
      calls.push(`wait:${processId}`);
    },
    install: async () => {
      calls.push("install");
    },
    restart: async () => {
      calls.push("restart");
    },
    removeHandoff: async () => {
      calls.push("remove-handoff");
    },
    cleanupHelper: async () => {
      calls.push("cleanup-helper");
    },
  });
  assert.deepEqual(calls, [
    "claim-handoff",
    "validate",
    "claim-lease",
    "wait:123",
    "wait:456",
    "install",
    "restart",
    "remove-handoff",
    "release",
    "cleanup-helper",
  ]);
});

test("installation failure still restarts and remains primary over restart and cleanup failures", async () => {
  const installationError = new Error("installation failed");
  const secondary: unknown[] = [];
  await assert.rejects(
    runUpdateHandoffWorkerOperation({
      parentProcessId: 123,
      claimHandoff: async () => handoff(),
      validateHandoff: async () => undefined,
      claimLease: async () => async () => {
        throw new Error("release failed");
      },
      waitForProcess: async () => undefined,
      install: async () => {
        throw installationError;
      },
      restart: async () => {
        throw new Error("restart failed");
      },
      removeHandoff: async () => {
        throw new Error("handoff cleanup failed");
      },
      cleanupHelper: async () => {
        throw new Error("helper cleanup failed");
      },
      reportSecondaryFailure: (error) => secondary.push(error),
    }),
    (error) => error === installationError,
  );
  assert.deepEqual(
    secondary.map((error) => (error as Error).message),
    ["restart failed", "handoff cleanup failed", "release failed", "helper cleanup failed"],
  );
});

test("restart failure remains primary over record, lease, and helper cleanup failures", async () => {
  const restartError = new Error("restart failed");
  const secondary: string[] = [];
  await assert.rejects(
    runUpdateHandoffWorkerOperation({
      parentProcessId: 123,
      claimHandoff: async () => handoff(),
      validateHandoff: async () => undefined,
      claimLease: async () => async () => {
        throw new Error("release failed");
      },
      waitForProcess: async () => undefined,
      install: async () => undefined,
      restart: async () => {
        throw restartError;
      },
      removeHandoff: async () => {
        throw new Error("handoff cleanup failed");
      },
      cleanupHelper: async () => {
        throw new Error("helper cleanup failed");
      },
      reportSecondaryFailure: (error) => secondary.push((error as Error).message),
    }),
    (error) => error === restartError,
  );
  assert.deepEqual(secondary, [
    "handoff cleanup failed",
    "release failed",
    "helper cleanup failed",
  ]);
});

test("stale handoff validation fails closed before lease claim or installation", async () => {
  const calls: string[] = [];
  const stale = new Error("update handoff has expired");
  await assert.rejects(
    runUpdateHandoffWorkerOperation({
      parentProcessId: 123,
      claimHandoff: async () => handoff(),
      validateHandoff: async () => {
        calls.push("validate");
        throw stale;
      },
      claimLease: async () => {
        calls.push("claim-lease");
        return async () => undefined;
      },
      waitForProcess: async () => {
        calls.push("wait");
      },
      install: async () => {
        calls.push("install");
      },
      restart: async () => {
        calls.push("restart");
      },
      removeHandoff: async () => {
        calls.push("remove-handoff");
      },
      cleanupHelper: async () => {
        calls.push("cleanup-helper");
      },
    }),
    (error) => error === stale,
  );
  assert.deepEqual(calls, ["validate", "remove-handoff", "cleanup-helper"]);
});

test("restart commands are argv arrays for all supported platforms", () => {
  const paths = {
    launcherPath: "C:\\Users\\A\\bin\\cinba.exe",
    desktopApplicationPath: "C:\\Users\\A\\Cinba.exe",
  } as ProductPaths;
  assert.deepEqual(createUpdateRestartCommand({ platform: "win32", paths, handoff: handoff() }), {
    executable: paths.desktopApplicationPath,
    arguments: [],
  });
  assert.deepEqual(
    createUpdateRestartCommand({
      platform: "darwin",
      paths: {
        ...paths,
        desktopApplicationPath: "/Users/a/Applications/Cinba.app",
      },
      handoff: handoff(),
    }),
    {
      executable: "/usr/bin/open",
      arguments: ["/Users/a/Applications/Cinba.app"],
    },
  );
  const tui = handoff("tui");
  assert.deepEqual(
    createUpdateRestartCommand({
      platform: "linux",
      paths: { ...paths, launcherPath: "/home/a/.local/bin/cinba" },
      handoff: tui,
    }),
    {
      executable: "/home/a/.local/bin/cinba",
      arguments: ["tui", (tui.restart as { workingDirectory: string }).workingDirectory],
      workingDirectory: (tui.restart as { workingDirectory: string }).workingDirectory,
    },
  );
});

test("surface restart uses the injectable argv runner", async () => {
  const calls: unknown[] = [];
  const updateHandoff = handoff("tui");
  await restartUpdateSurface({
    platform: "linux",
    paths: {
      launcherPath: "/home/a/.local/bin/cinba",
      desktopApplicationPath: null,
    } as ProductPaths,
    handoff: updateHandoff,
    run: async (command) => {
      calls.push(command);
    },
  });
  assert.deepEqual(calls, [
    {
      executable: "/home/a/.local/bin/cinba",
      arguments: ["tui", (updateHandoff.restart as { workingDirectory: string }).workingDirectory],
      workingDirectory: (updateHandoff.restart as { workingDirectory: string }).workingDirectory,
    },
  ]);
});

test("process waiting treats an already exited PID as success without delay", async () => {
  let delays = 0;
  await waitForProcessExit(123, {
    processIsAlive: () => false,
    delay: async () => {
      delays += 1;
    },
  });
  assert.equal(delays, 0);
});
