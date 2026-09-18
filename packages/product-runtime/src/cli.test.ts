import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createProductCoreConfig,
  createProductServiceProcess,
  parseProductCommand,
} from "./cli.ts";

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
  });
  assert.equal(service.entry, join(payload, "lib", "sync.mjs"));
  assert.equal(service.environment.CINBA_SYNC_HOST, "127.0.0.1");
  assert.equal(service.environment.CINBA_SYNC_PORT, "4518");
  assert.equal(
    service.environment.CINBA_SYNC_STATE_DIR,
    "/Users/ada/Library/Application Support/com.soundoer.cinba/Data/Sync",
  );
  assert.equal(service.environment.CINBA_SYNC_WEB_ROOT, join(payload, "sync-web"));
});
