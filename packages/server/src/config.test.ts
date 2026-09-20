import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import { createLocalStateStore } from "./config.ts";

function fixture(t: TestContext) {
  const root = temporaryDirectory("cinba-local-state-", t);
  const projectPath = join(root, "project");
  mkdirSync(projectPath);
  return {
    root,
    stateDirectory: join(root, ".cinba"),
    configPath: join(root, ".cinba", "config.json"),
    projectPath,
  };
}

test("a missing Local State file starts with the supplied Core defaults", (t) => {
  const files = fixture(t);
  const store = createLocalStateStore(files.configPath, {
    cwd: files.projectPath,
    coreName: "test-machine",
  });
  assert.deepEqual(store.get(), {
    cwd: files.projectPath,
    lastSessionId: undefined,
    coreName: "test-machine",
  });
  assert.equal(store.problem(), undefined);
});

test("Local State reads facts but neither consumes nor migrates legacy settings", (t) => {
  const files = fixture(t);
  mkdirSync(files.stateDirectory);
  writeFileSync(
    files.configPath,
    JSON.stringify({
      cwd: files.projectPath,
      provider: "deepseek",
      modelId: "deepseek-chat",
      lastSessionId: "session-1",
      coreName: "  studio  ",
      webSearchPrimary: "brave",
    }),
  );
  const store = createLocalStateStore(files.configPath, {
    cwd: files.root,
    coreName: "test-machine",
  });

  assert.deepEqual(store.get(), {
    cwd: files.projectPath,
    lastSessionId: "session-1",
    coreName: "studio",
  });
  store.update({ lastSessionId: "session-2" });
  assert.deepEqual(JSON.parse(readFileSync(files.configPath, "utf8")), {
    provider: "deepseek",
    modelId: "deepseek-chat",
    webSearchPrimary: "brave",
    cwd: files.projectPath,
    coreName: "studio",
    lastSessionId: "session-2",
  });
});

test("updating Local State does not rewrite Settings or Credentials", (t) => {
  const files = fixture(t);
  mkdirSync(files.stateDirectory);
  const settingsPath = join(files.stateDirectory, "local-settings.json");
  const credentialsPath = join(files.stateDirectory, "credentials.json");
  const settingsBody = '{"settings":"untouched"}';
  const credentialsBody = '{"credentials":"untouched"}';
  writeFileSync(settingsPath, settingsBody);
  writeFileSync(credentialsPath, credentialsBody);
  const store = createLocalStateStore(files.configPath, {
    cwd: files.projectPath,
    coreName: "test-machine",
  });

  store.update({ lastSessionId: "session-2", coreName: "studio" });

  assert.equal(readFileSync(settingsPath, "utf8"), settingsBody);
  assert.equal(readFileSync(credentialsPath, "utf8"), credentialsBody);
});

test("malformed Local State is preserved and refuses overwrite", (t) => {
  const files = fixture(t);
  mkdirSync(files.stateDirectory);
  const original = "{ definitely broken";
  writeFileSync(files.configPath, original);
  const store = createLocalStateStore(files.configPath, {
    cwd: files.projectPath,
    coreName: "test-machine",
  });

  assert.ok(store.problem());
  assert.throws(() => store.update({ coreName: "replacement" }), /unreadable or unsupported/);
  assert.equal(readFileSync(files.configPath, "utf8"), original);
});
