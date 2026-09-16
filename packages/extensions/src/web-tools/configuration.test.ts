import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WEB_TOOLS_RUNTIME_CONFIG_ENV, loadWebSearchConfiguration } from "./configuration.ts";

test("an explicit Core runtime configuration is authoritative", () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-web-runtime-"));
  try {
    const path = join(root, "runtime.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        webTools: {
          searchPrimary: "brave",
          apiKeys: { brave: "resolved-brave-key" },
        },
      }),
    );

    assert.deepEqual(
      loadWebSearchConfiguration({
        [WEB_TOOLS_RUNTIME_CONFIG_ENV]: path,
        CINBA_STATE_DIR: join(root, "unused"),
        EXA_API_KEY: "must-not-be-read",
      }),
      { primary: "brave", apiKeys: { brave: "resolved-brave-key" } },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid explicit runtime configuration fails instead of falling back", () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-web-runtime-"));
  try {
    const path = join(root, "runtime.json");
    writeFileSync(path, "{ broken");

    assert.throws(
      () =>
        loadWebSearchConfiguration({
          [WEB_TOOLS_RUNTIME_CONFIG_ENV]: path,
          EXA_API_KEY: "must-not-be-read",
        }),
      /JSON/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the compatibility path remains local when no runtime file is supplied", () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-web-runtime-"));
  try {
    writeFileSync(
      join(root, "local-settings.json"),
      JSON.stringify({ version: 1, webTools: { searchPrimary: "exa" } }),
    );
    assert.deepEqual(
      loadWebSearchConfiguration({ CINBA_STATE_DIR: root, EXA_API_KEY: "local-exa" }),
      { primary: "exa", apiKeys: { exa: "local-exa", brave: undefined } },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
