import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { requireProductTarget } from "@cinba/installer";
import {
  createProductCoreConfig,
  createProductServiceProcess,
  createProductTuiEnvironment,
  formatProductHelp,
  parseProductCommand,
  runProductCli,
} from "./cli.ts";
import type { ProductRelease } from "./release.ts";

const release: ProductRelease = {
  schemaVersion: 1,
  product: "Cinba",
  version: "0.1.0",
  revision: "a".repeat(40),
  protocolVersion: 1,
  dataFormatVersion: 1,
  target: requireProductTarget(),
  nodeVersion: "24.0.0",
};

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolvePromise = settle;
  });
  return { promise, resolve: resolvePromise };
}

test("the installed command defaults to the TUI and keeps management explicit", () => {
  const project = resolve("project");
  assert.deepEqual(parseProductCommand([], project), { type: "tui", workingDirectory: project });
  assert.deepEqual(parseProductCommand(["core", "start"], project), {
    type: "core",
    action: "start",
  });
  assert.deepEqual(parseProductCommand(["--version"], project), { type: "version" });
  assert.deepEqual(parseProductCommand(["doctor"], project), { type: "doctor" });
  assert.deepEqual(parseProductCommand(["service", "core"], project), {
    type: "service",
    component: "core",
  });
  assert.deepEqual(parseProductCommand(["core", "mode"], project), {
    type: "component-mode",
    component: "core",
    mode: null,
  });
  assert.deepEqual(parseProductCommand(["core", "mode", "background"], project), {
    type: "component-mode",
    component: "core",
    mode: "background",
  });
  assert.deepEqual(parseProductCommand(["sync", "mode", "disabled"], project), {
    type: "component-mode",
    component: "sync",
    mode: "disabled",
  });
  assert.throws(() => parseProductCommand(["core", "mode", "disabled"], project), {
    message: "core does not support mode disabled",
  });
  assert.match(formatProductHelp(), /cinba update/);
});

test("the installed Core separates durable data, runtime state, logs, and payload", () => {
  const payload = resolve("payload");
  const config = createProductCoreConfig(payload, {
    platform: "win32",
    homeDirectory: "C:\\Users\\Ada",
    environment: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
  });
  assert.equal(config.repositoryRoot, payload);
  assert.equal(config.serverEntry, join(payload, "lib", "core.mjs"));
  assert.equal(config.stateDirectory, "C:\\Users\\Ada\\AppData\\Local\\Cinba\\Data\\Core");
  assert.equal(config.piAgentDirectory, "C:\\Users\\Ada\\AppData\\Local\\Cinba\\Data\\Pi");
  assert.equal(
    config.runtimePath,
    "C:\\Users\\Ada\\AppData\\Local\\Cinba\\State\\core-runtime.json",
  );
  assert.equal(config.logPath, "C:\\Users\\Ada\\AppData\\Local\\Cinba\\Logs\\core.log");
  assert.equal(config.environment?.CINBA_EXTENSION_ROOT, join(payload, "extensions"));
  assert.equal(config.environment?.CINBA_WEB_ROOT, join(payload, "web"));
});

test("the internal Core service is persistent and uses only stable product data", () => {
  const payload = resolve("payload");
  const service = createProductServiceProcess(payload, "a".repeat(40), "core", {
    platform: "linux",
    homeDirectory: "/home/ada",
    environment: { CINBA_LOCAL_CONTROL_TOKEN: "development-token" },
  });
  assert.equal(service.entry, join(payload, "lib", "core.mjs"));
  assert.equal(service.environment.CINBA_CORE_LIFETIME, "persistent");
  assert.equal(service.environment.CINBA_REVISION, "a".repeat(40));
  assert.equal(service.environment.CINBA_PORT, "4517");
  assert.equal(service.environment.CINBA_STATE_DIR, "/home/ada/.local/share/cinba/data/Core");
  assert.equal(service.environment.PI_CODING_AGENT_DIR, "/home/ada/.local/share/cinba/data/Pi");
  assert.equal(service.environment.CINBA_LOCAL_CONTROL_TOKEN, undefined);
});

test("the internal Sync service is loopback-only and isolated from Core data", () => {
  const payload = resolve("payload");
  const service = createProductServiceProcess(payload, "b".repeat(40), "sync", {
    platform: "darwin",
    homeDirectory: "/Users/ada",
    environment: {},
    managedService: true,
  });
  assert.equal(service.entry, join(payload, "lib", "sync.mjs"));
  assert.equal(service.environment.CINBA_SYNC_HOST, "127.0.0.1");
  assert.equal(service.environment.CINBA_SYNC_PORT, "4518");
  assert.equal(
    service.environment.CINBA_SYNC_STATE_DIR,
    "/Users/ada/Library/Application Support/com.soundoer.cinba/Data/Sync",
  );
  assert.equal(service.environment.CINBA_SYNC_WEB_ROOT, join(payload, "sync-web"));
  assert.equal(
    service.controlStateDirectory,
    "/Users/ada/Library/Application Support/com.soundoer.cinba/State",
  );
});

test("foreground Sync never receives managed ownership records or a control token", () => {
  const service = createProductServiceProcess(resolve("payload"), "b".repeat(40), "sync", {
    platform: "linux",
    homeDirectory: "/home/ada",
    environment: { CINBA_LOCAL_SYNC_CONTROL_TOKEN: "inherited" },
  });
  assert.equal(service.controlStateDirectory, undefined);
  assert.equal(service.environment.CINBA_LOCAL_SYNC_CONTROL_TOKEN, undefined);
});

test("the installed TUI receives only the shared update state directory and preserves its env", () => {
  assert.deepEqual(createProductTuiEnvironment("/state", { EXISTING: "kept" }), {
    EXISTING: "kept",
    CINBA_UPDATE_STATE_DIR: "/state",
  });
});

test("the installed TUI aborts and joins its non-blocking automatic update check", async () => {
  let checks = 0;
  let executions = 0;
  let signal: AbortSignal | undefined;
  const tuiStarted = deferred<void>();
  const aborted = deferred<void>();
  const cleanup = deferred<undefined>();
  const running = runProductCli([], resolve("project"), {
    readRelease: async () => release,
    checkForUpdates: (options) => {
      checks += 1;
      signal = options.signal;
      signal?.addEventListener("abort", () => aborted.resolve());
      return cleanup.promise;
    },
    executeCommand: async (command) => {
      executions += 1;
      assert.equal(command.type, "tui");
      assert.equal(checks, 1);
      assert.equal(signal?.aborted, false);
      tuiStarted.resolve();
    },
  });

  await tuiStarted.promise;
  assert.equal(checks, 1);
  assert.equal(executions, 1);
  assert.equal(
    await Promise.race([
      aborted.promise.then(() => true),
      new Promise<boolean>((settle) => setImmediate(() => settle(false))),
    ]),
    true,
  );
  await aborted.promise;
  assert.equal(signal?.aborted, true);

  let completed = false;
  void running.then(() => {
    completed = true;
  });
  await Promise.resolve();
  assert.equal(completed, false);

  cleanup.resolve(undefined);
  await running;
  assert.equal(completed, true);
});

test("TUI failure is preserved after automatic update cleanup", async () => {
  const childError = new Error("terminal stopped by SIGTERM");
  const cleanup = deferred<undefined>();
  const aborted = deferred<void>();
  const running = runProductCli([], resolve("project"), {
    readRelease: async () => release,
    checkForUpdates: (options) => {
      options.signal?.addEventListener("abort", () => aborted.resolve());
      return cleanup.promise;
    },
    executeCommand: async () => {
      throw childError;
    },
  });

  const rejection = assert.rejects(running, (error: unknown) => error === childError);
  assert.equal(
    await Promise.race([
      aborted.promise.then(() => true),
      new Promise<boolean>((settle) => setImmediate(() => settle(false))),
    ]),
    true,
  );
  await aborted.promise;
  cleanup.resolve(undefined);
  await rejection;
});

test("non-TUI installed commands do not start automatic update checks", async () => {
  const commands = [
    ["help"],
    ["version"],
    ["doctor"],
    ["service", "core"],
    ["core", "status"],
    ["sync", "serve"],
  ];
  let checks = 0;
  let executions = 0;

  for (const commandArguments of commands) {
    await runProductCli(commandArguments, resolve("project"), {
      readRelease: async () => release,
      checkForUpdates: async () => {
        checks += 1;
        return undefined;
      },
      executeCommand: async () => {
        executions += 1;
      },
    });
  }

  assert.equal(checks, 0);
  assert.equal(executions, commands.length);
});
