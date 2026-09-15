import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigStore } from "./config.ts";

function fixture(): {
  root: string;
  configPath: string;
  projectPath: string;
  close: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "cinba-config-"));
  const projectPath = join(root, "project");
  mkdirSync(projectPath);
  return {
    root,
    configPath: join(root, ".cinba", "config.json"),
    projectPath,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("a missing file starts with the supplied defaults", () => {
  const files = fixture();
  try {
    const store = createConfigStore(files.configPath, {
      cwd: files.projectPath,
      coreName: "test-machine",
    });

    assert.deepEqual(store.get(), {
      cwd: files.projectPath,
      model: undefined,
      lastSessionId: undefined,
      coreName: "test-machine",
      webSearchPrimary: "auto",
    });
  } finally {
    files.close();
  }
});

test("valid persisted values replace the defaults", () => {
  const files = fixture();
  try {
    mkdirSync(join(files.root, ".cinba"));
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

    const store = createConfigStore(files.configPath, {
      cwd: files.root,
      coreName: "test-machine",
    });

    assert.deepEqual(store.get(), {
      cwd: files.projectPath,
      model: { provider: "deepseek", id: "deepseek-chat" },
      lastSessionId: "session-1",
      coreName: "studio",
      webSearchPrimary: "brave",
    });
  } finally {
    files.close();
  }
});

test("invalid persisted fields leave their defaults intact", () => {
  const files = fixture();
  try {
    mkdirSync(join(files.root, ".cinba"));
    writeFileSync(
      files.configPath,
      JSON.stringify({
        cwd: join(files.root, "missing"),
        provider: "deepseek",
        lastSessionId: 42,
        coreName: "   ",
      }),
    );

    const store = createConfigStore(files.configPath, {
      cwd: files.projectPath,
      coreName: "test-machine",
    });

    assert.deepEqual(store.get(), {
      cwd: files.projectPath,
      model: undefined,
      lastSessionId: undefined,
      coreName: "test-machine",
      webSearchPrimary: "auto",
    });
  } finally {
    files.close();
  }
});

test("updating changes memory and persists the complete config", () => {
  const files = fixture();
  try {
    const store = createConfigStore(files.configPath, {
      cwd: files.projectPath,
      coreName: "test-machine",
    });

    store.update({
      model: { provider: "openai", id: "gpt-test" },
      lastSessionId: "session-2",
      webSearchPrimary: "brave",
    });

    assert.deepEqual(store.get(), {
      cwd: files.projectPath,
      model: { provider: "openai", id: "gpt-test" },
      lastSessionId: "session-2",
      coreName: "test-machine",
      webSearchPrimary: "brave",
    });
    assert.deepEqual(JSON.parse(readFileSync(files.configPath, "utf8")), {
      cwd: files.projectPath,
      provider: "openai",
      modelId: "gpt-test",
      lastSessionId: "session-2",
      coreName: "test-machine",
      webSearchPrimary: "brave",
    });
  } finally {
    files.close();
  }
});
