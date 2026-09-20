import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import { WEB_TOOLS_RUNTIME_CONFIG_ENV, loadWebSearchConfiguration } from "./configuration.ts";

test("an explicit Core runtime configuration is authoritative", (t) => {
  const root = temporaryDirectory("cinba-web-runtime-", t);
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
});

test("an invalid explicit runtime configuration fails instead of falling back", (t) => {
  const root = temporaryDirectory("cinba-web-runtime-", t);
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
});

test("the compatibility path remains local when no runtime file is supplied", (t) => {
  const root = temporaryDirectory("cinba-web-runtime-", t);
  writeFileSync(
    join(root, "local-settings.json"),
    JSON.stringify({ version: 1, webTools: { searchPrimary: "exa" } }),
  );
  assert.deepEqual(
    loadWebSearchConfiguration({ CINBA_STATE_DIR: root, EXA_API_KEY: "local-exa" }),
    { primary: "exa", apiKeys: { exa: "local-exa", brave: undefined } },
  );
});
