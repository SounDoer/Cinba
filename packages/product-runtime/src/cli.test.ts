import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { createProductCoreConfig, parseProductCommand } from "./cli.ts";

test("the installed command defaults to the TUI and keeps management explicit", () => {
  const project = resolve("project");
  assert.deepEqual(parseProductCommand([], project), { type: "tui", workingDirectory: project });
  assert.deepEqual(parseProductCommand(["core", "start"], project), {
    type: "core",
    action: "start",
  });
  assert.deepEqual(parseProductCommand(["--version"], project), { type: "version" });
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
