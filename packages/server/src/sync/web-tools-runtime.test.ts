import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  resolveWebToolsRuntimeConfiguration,
  writeWebToolsRuntimeConfiguration,
} from "./web-tools-runtime.ts";

test("effective Web tools runtime config contains only resolved values and replaces atomically", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "cinba-web-runtime-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "runtime.json");
  writeWebToolsRuntimeConfiguration(path, {
    version: 1,
    webTools: { searchPrimary: "exa", apiKeys: { exa: "first-key" } },
  });
  writeWebToolsRuntimeConfiguration(path, {
    version: 1,
    webTools: { searchPrimary: "brave", apiKeys: { brave: "second-key" } },
  });
  const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.equal(JSON.stringify(document).includes("first-key"), false);
  assert.deepEqual(document, {
    version: 1,
    webTools: { searchPrimary: "brave", apiKeys: { brave: "second-key" } },
  });
});

test("Local, Shared, and Dev-local Web Search credentials stay in their selected source", () => {
  const settings = { defaultModel: undefined, webTools: { searchPrimary: "exa" as const } };
  const localCredential = (provider: "exa" | "brave") => `local-${provider}`;
  const sharedCredentials = { exa: "shared-exa", brave: "shared-brave" };
  assert.deepEqual(
    resolveWebToolsRuntimeConfiguration({
      settings,
      credentialSource: "local",
      localCredential,
      sharedCredentials,
    }).webTools.apiKeys,
    { exa: "local-exa", brave: "local-brave" },
  );
  assert.deepEqual(
    resolveWebToolsRuntimeConfiguration({
      settings,
      credentialSource: "sync",
      localCredential,
      sharedCredentials,
    }).webTools.apiKeys,
    { exa: "shared-exa", brave: "shared-brave" },
  );
  assert.equal(
    JSON.stringify(
      resolveWebToolsRuntimeConfiguration({
        settings,
        credentialSource: "local",
        localCredential: () => undefined,
        sharedCredentials: { exa: "production-key" },
      }),
    ).includes("production-key"),
    false,
  );
});
