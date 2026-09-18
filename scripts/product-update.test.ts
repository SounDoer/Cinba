import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { UpdateState } from "@cinba/installer";
import {
  coordinateProductUpdate,
  installPreparedCandidate,
  runExplicitProductUpdate,
} from "./product-update.ts";

function readyState(): UpdateState {
  return {
    schemaVersion: 1,
    phase: "ready",
    currentVersion: "0.1.0",
    checkedAt: "2026-09-18T01:02:03.000Z",
    candidate: {
      version: "0.2.0",
      revision: "a".repeat(40),
      target: "windows-x64",
      artifactPath: resolve("cache", "Cinba.exe"),
      size: 42,
      sha256: "b".repeat(64),
      releaseUrl: "https://github.com/SounDoer/Cinba/releases/tag/v0.2.0",
    },
    failure: null,
  };
}

test("an explicit current check bypasses automatic throttling and reports clearly", async () => {
  const output: string[] = [];
  let automatic: boolean | undefined;
  await runExplicitProductUpdate({
    interactive: false,
    prepare: async (options) => {
      automatic = options.automatic;
      return { ...readyState(), phase: "current", candidate: null };
    },
    confirm: async () => false,
    install: async () => assert.fail("current releases must not install"),
    write: (message) => output.push(message),
  });
  assert.equal(automatic, false);
  assert.deepEqual(output, ["Cinba 0.1.0 is current."]);
});

test("a non-interactive update never installs silently", async () => {
  const output: string[] = [];
  let installed = false;
  await runExplicitProductUpdate({
    interactive: false,
    prepare: async () => readyState(),
    confirm: async () => assert.fail("non-interactive updates must not prompt"),
    install: async () => {
      installed = true;
    },
    write: (message) => output.push(message),
  });
  assert.equal(installed, false);
  assert.deepEqual(output, [
    "Cinba 0.2.0 is ready to install.",
    "Run cinba update in an interactive terminal to install it.",
  ]);
});
test("Later keeps a ready update without installing it", async () => {
  const output: string[] = [];
  let installed = false;
  await runExplicitProductUpdate({
    interactive: true,
    prepare: async () => readyState(),
    confirm: async () => false,
    install: async () => {
      installed = true;
    },
    write: (message) => output.push(message),
  });
  assert.equal(installed, false);
  assert.deepEqual(output, ["Cinba 0.2.0 is ready to install.", "Update kept for later."]);
});

test("a successful candidate installation records the new current version", async () => {
  const calls: string[] = [];
  await installPreparedCandidate({
    stateDirectory: resolve("state"),
    currentVersion: "0.1.0",
    candidate: readyState().candidate!,
    install: async () => {
      calls.push("install");
    },
    readCurrent: async () => ({
      version: "0.2.0",
      revision: readyState().candidate!.revision,
      target: "windows-x64",
    }),
    record: async (options) => {
      calls.push(`record:${options.result}:${options.candidate.version}`);
    },
    cleanup: async () => {
      calls.push("cleanup");
    },
  });
  assert.deepEqual(calls, ["install", "record:installed:0.2.0", "cleanup"]);
});

test("a failed candidate installation records retry state and preserves its error", async () => {
  const original = new Error("install failed");
  const calls: string[] = [];
  await assert.rejects(
    installPreparedCandidate({
      stateDirectory: resolve("state"),
      currentVersion: "0.1.0",
      candidate: readyState().candidate!,
      install: async () => {
        calls.push("install");
        throw original;
      },
      readCurrent: async () => ({
        version: "0.1.0",
        revision: "0".repeat(40),
        target: "windows-x64",
      }),
      record: async (options) => {
        calls.push(`record:${options.result}:${options.candidate.version}`);
        throw new Error("state write failed");
      },
    }),
    (error) => error === original,
  );
  assert.deepEqual(calls, ["install", "record:failed:0.2.0"]);
});

test("a committed candidate records current even when lifecycle recovery throws", async () => {
  const original = new Error("lifecycle restoration failed");
  const calls: string[] = [];
  await assert.rejects(
    installPreparedCandidate({
      stateDirectory: resolve("state"),
      currentVersion: "0.1.0",
      candidate: readyState().candidate!,
      install: async () => {
        calls.push("install");
        throw original;
      },
      readCurrent: async () => ({
        version: "0.2.0",
        revision: readyState().candidate!.revision,
        target: "windows-x64",
      }),
      record: async (options) => {
        calls.push(`record:${options.result}:${options.candidate.version}`);
      },
      cleanup: async () => {
        calls.push("cleanup");
      },
    }),
    (error) => error === original,
  );
  assert.deepEqual(calls, ["install", "record:installed:0.2.0"]);
});

test("cleanup failure warns after committed state without undoing installation success", async () => {
  const cleanupError = new Error("old release cleanup failed");
  const calls: string[] = [];
  const warnings: unknown[] = [];
  await installPreparedCandidate({
    stateDirectory: resolve("state"),
    currentVersion: "0.1.0",
    candidate: readyState().candidate!,
    install: async () => {
      calls.push("install");
    },
    readCurrent: async () => ({
      version: "0.2.0",
      revision: readyState().candidate!.revision,
      target: "windows-x64",
    }),
    record: async ({ result }) => {
      calls.push(`record:${result}`);
    },
    cleanup: async () => {
      calls.push("cleanup");
      throw cleanupError;
    },
    reportCleanupFailure: (error) => {
      warnings.push(error);
    },
  });
  assert.deepEqual(calls, ["install", "record:installed", "cleanup"]);
  assert.deepEqual(warnings, [cleanupError]);
});

test("a busy Core is rejected before service state changes or installation", async () => {
  const calls: string[] = [];
  await assert.rejects(
    coordinateProductUpdate({
      inspectCore: async () => ({
        running: true,
        managed: true,
        safeToStop: false,
      }),
      inspectComponent: async (component) => {
        calls.push(`inspect:${component}`);
        return { mode: "background", running: true };
      },
      inspectSync: async () => ({ running: true, managed: true, safeToStop: true }),
      stopSync: async () => {
        calls.push("stop:sync");
      },
      setComponentMode: async (component, mode) => {
        calls.push(`mode:${component}:${mode}`);
      },
      stopCore: async () => {
        calls.push("stop:core");
      },
      startCore: async () => {
        calls.push("start:core");
      },
      install: async () => {
        calls.push("install");
      },
    }),
    /active work/,
  );
  assert.deepEqual(calls, ["inspect:core", "inspect:sync"]);
});

test("an unowned local Sync is rejected before state changes", async () => {
  const calls: string[] = [];
  await assert.rejects(
    coordinateProductUpdate({
      inspectCore: async () => ({ running: false, managed: false }),
      inspectComponent: async () => ({ mode: "on-demand", running: false }),
      inspectSync: async () => ({ running: true, managed: false }),
      stopSync: async () => {
        calls.push("stop:sync");
      },
      setComponentMode: async (component, mode) => {
        calls.push(`mode:${component}:${mode}`);
      },
      stopCore: async () => {
        calls.push("stop:core");
      },
      startCore: async () => {
        calls.push("start:core");
      },
      install: async () => {
        calls.push("install");
      },
    }),
    /unmanaged Sync/,
  );
  assert.deepEqual(calls, []);
});

test("a Background Sync that cannot confirm graceful stop fails closed before installation", async () => {
  const calls: string[] = [];
  let inspections = 0;
  await assert.rejects(
    coordinateProductUpdate({
      inspectCore: async () => ({ running: false, managed: false }),
      inspectComponent: async (component) =>
        component === "core"
          ? { mode: "on-demand", running: false }
          : { mode: "background", running: true },
      inspectSync: async () => {
        calls.push("inspect:sync");
        inspections += 1;
        return { running: true, managed: inspections === 1, safeToStop: true };
      },
      stopSync: async () => {
        calls.push("stop:sync");
      },
      setComponentMode: async (component, mode) => {
        calls.push(`mode:${component}:${mode}`);
      },
      stopCore: async () => undefined,
      startCore: async () => undefined,
      install: async () => {
        calls.push("install");
      },
    }),
    /did not stop/,
  );
  assert.deepEqual(calls, ["inspect:sync", "stop:sync", "inspect:sync", "inspect:sync"]);
});

test("a stop that was not accepted leaves a healthy Background Sync running", async () => {
  const calls: string[] = [];
  let inspections = 0;
  await assert.rejects(
    coordinateProductUpdate({
      inspectCore: async () => ({ running: false, managed: false }),
      inspectComponent: async (component) =>
        component === "core"
          ? { mode: "on-demand", running: false }
          : { mode: "background", running: true },
      inspectSync: async () => {
        inspections += 1;
        calls.push(`inspect:sync:${inspections}`);
        return {
          running: true,
          managed: true,
          safeToStop: true,
          draining: false,
        };
      },
      stopSync: async () => {
        calls.push("stop:sync");
        throw new Error("graceful stop refused");
      },
      setComponentMode: async (component, mode) => {
        calls.push(`mode:${component}:${mode}`);
      },
      stopCore: async () => undefined,
      startCore: async () => undefined,
      install: async () => {
        calls.push("install");
      },
    }),
    /graceful stop refused/,
  );
  assert.deepEqual(calls, ["inspect:sync:1", "stop:sync", "inspect:sync:2"]);
});

test("a busy managed Sync is rejected before stop or installation", async () => {
  const calls: string[] = [];
  await assert.rejects(
    coordinateProductUpdate({
      inspectCore: async () => ({ running: false, managed: false }),
      inspectComponent: async (component) =>
        component === "core"
          ? { mode: "on-demand", running: false }
          : { mode: "background", running: true },
      inspectSync: async () => ({ running: true, managed: true, safeToStop: false }),
      stopSync: async () => {
        calls.push("stop:sync");
      },
      setComponentMode: async (component, mode) => {
        calls.push(`mode:${component}:${mode}`);
      },
      stopCore: async () => undefined,
      startCore: async () => undefined,
      install: async () => {
        calls.push("install");
      },
    }),
    /active requests/,
  );
  assert.deepEqual(calls, []);
});

test("a transport error after accepted Sync stop waits and rebuilds Background registration", async () => {
  const original = new Error("stop response was lost");
  const calls: string[] = [];
  let inspections = 0;
  await assert.rejects(
    coordinateProductUpdate({
      inspectCore: async () => ({ running: false, managed: false }),
      inspectComponent: async (component) =>
        component === "core"
          ? { mode: "on-demand", running: false }
          : { mode: "background", running: true },
      inspectSync: async () => {
        inspections += 1;
        calls.push(`inspect:sync:${inspections}`);
        return inspections === 1
          ? {
              running: true,
              managed: true,
              safeToStop: true,
              draining: false,
            }
          : {
              running: true,
              managed: true,
              safeToStop: false,
              draining: true,
            };
      },
      stopSync: async () => {
        calls.push("stop:sync");
        throw original;
      },
      waitForSyncExit: async () => {
        calls.push("wait:sync-exit");
      },
      setComponentMode: async (component, mode) => {
        calls.push(`mode:${component}:${mode}`);
      },
      stopCore: async () => undefined,
      startCore: async () => undefined,
      install: async () => {
        calls.push("install");
      },
    }),
    (error) => error === original,
  );
  assert.deepEqual(calls, [
    "inspect:sync:1",
    "stop:sync",
    "inspect:sync:2",
    "wait:sync-exit",
    "mode:sync:disabled",
    "mode:sync:background",
  ]);
});

test("a failed accepted stop reports reconcile failure without replacing the transport error", async () => {
  const original = new Error("stop response was lost");
  const recovery = new Error("Sync exit could not be confirmed");
  const calls: string[] = [];
  const reported: unknown[] = [];
  let inspections = 0;
  await assert.rejects(
    coordinateProductUpdate({
      inspectCore: async () => ({ running: false, managed: false }),
      inspectComponent: async (component) =>
        component === "core"
          ? { mode: "on-demand", running: false }
          : { mode: "background", running: true },
      inspectSync: async () => {
        inspections += 1;
        return inspections === 1
          ? { running: true, managed: true, safeToStop: true, draining: false }
          : { running: true, managed: true, safeToStop: false, draining: true };
      },
      stopSync: async () => {
        throw original;
      },
      waitForSyncExit: async () => {
        calls.push("wait:sync-exit");
        throw recovery;
      },
      setComponentMode: async (component, mode) => {
        calls.push(`mode:${component}:${mode}`);
      },
      stopCore: async () => undefined,
      startCore: async () => undefined,
      install: async () => {
        calls.push("install");
      },
      reportRecoveryFailure: (error) => {
        reported.push(error);
      },
    }),
    (error) => error === original,
  );
  assert.deepEqual(calls, ["wait:sync-exit"]);
  assert.deepEqual(reported, [recovery]);
});

test("successful installation restores original modes and running components", async () => {
  const calls: string[] = [];
  let syncInspections = 0;
  await coordinateProductUpdate({
    inspectCore: async () => ({ running: true, managed: true, safeToStop: true }),
    inspectComponent: async (component) => {
      calls.push(`inspect:${component}`);
      return component === "core"
        ? { mode: "on-demand", running: false }
        : { mode: "background", running: true };
    },
    inspectSync: async () => {
      calls.push("inspect:sync-control");
      syncInspections += 1;
      return syncInspections === 1
        ? { running: true, managed: true, safeToStop: true }
        : { running: false, managed: false };
    },
    stopSync: async () => {
      calls.push("stop:sync");
    },
    setComponentMode: async (component, mode) => {
      calls.push(`mode:${component}:${mode}`);
    },
    stopCore: async () => {
      calls.push("stop:core");
    },
    startCore: async () => {
      calls.push("start:core");
    },
    install: async () => {
      calls.push("install");
    },
  });
  assert.deepEqual(calls, [
    "inspect:core",
    "inspect:sync",
    "inspect:sync-control",
    "stop:core",
    "stop:sync",
    "inspect:sync-control",
    "mode:sync:disabled",
    "install",
    "mode:sync:background",
    "start:core",
  ]);
});

test("stopped Background components keep their mode without being started", async () => {
  const calls: string[] = [];
  await coordinateProductUpdate({
    inspectCore: async () => ({ running: false, managed: false }),
    inspectComponent: async () => ({ mode: "background", running: false }),
    inspectSync: async () => ({ running: false, managed: false }),
    stopSync: async () => {
      calls.push("stop:sync");
    },
    setComponentMode: async (component, mode) => {
      calls.push(`mode:${component}:${mode}`);
    },
    stopCore: async () => {
      calls.push("stop:core");
    },
    startCore: async () => {
      calls.push("start:core");
    },
    install: async () => {
      calls.push("install");
    },
  });
  assert.deepEqual(calls, ["install"]);
});

test("installation failure restores old state and preserves the original error", async () => {
  const original = new Error("installer rejected the candidate");
  const calls: string[] = [];
  let syncInspections = 0;
  await assert.rejects(
    coordinateProductUpdate({
      inspectCore: async () => ({ running: true, managed: true, safeToStop: true }),
      inspectComponent: async (component) => {
        calls.push(`inspect:${component}`);
        return { mode: "background", running: true };
      },
      inspectSync: async () => {
        calls.push("inspect:sync-control");
        syncInspections += 1;
        return syncInspections === 1
          ? { running: true, managed: true, safeToStop: true }
          : { running: false, managed: false };
      },
      stopSync: async () => {
        calls.push("stop:sync");
      },
      setComponentMode: async (component, mode) => {
        calls.push(`mode:${component}:${mode}`);
      },
      stopCore: async () => {
        calls.push("stop:core");
      },
      startCore: async () => {
        calls.push("start:core");
      },
      install: async () => {
        calls.push("install");
        throw original;
      },
    }),
    (error) => error === original,
  );
  assert.deepEqual(calls, [
    "inspect:core",
    "inspect:sync",
    "inspect:sync-control",
    "stop:core",
    "mode:core:on-demand",
    "stop:sync",
    "inspect:sync-control",
    "mode:sync:disabled",
    "install",
    "mode:sync:background",
    "mode:core:background",
  ]);
});
