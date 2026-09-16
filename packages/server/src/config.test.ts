import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalStateStore } from "./config.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cinba-local-state-"));
  const projectPath = join(root, "project");
  mkdirSync(projectPath);
  return {
    root,
    stateDirectory: join(root, ".cinba"),
    configPath: join(root, ".cinba", "config.json"),
    projectPath,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("a missing Local State file starts with the supplied Core defaults", () => {
  const files = fixture();
  try {
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
  } finally {
    files.close();
  }
});

test("Local State reads facts but neither consumes nor migrates legacy settings", () => {
  const files = fixture();
  try {
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
  } finally {
    files.close();
  }
});

test("updating Local State does not rewrite Settings or Credentials", () => {
  const files = fixture();
  try {
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
  } finally {
    files.close();
  }
});

test("malformed Local State is preserved and refuses overwrite", () => {
  const files = fixture();
  try {
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
  } finally {
    files.close();
  }
});
