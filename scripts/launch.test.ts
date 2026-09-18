import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveProductPaths } from "@cinba/installer";
import {
  browserOpenCommand,
  createDevelopmentEnvironment,
  createSyncDevelopmentEnvironment,
} from "./launch.ts";

function developmentPaths(homeDirectory: string) {
  if (
    process.platform !== "win32" &&
    process.platform !== "darwin" &&
    process.platform !== "linux"
  ) {
    throw new Error(`unsupported test platform: ${process.platform}`);
  }
  return resolveProductPaths({
    platform: process.platform,
    homeDirectory,
    identity: "development",
    environment: { PATH: "/usr/bin" },
  });
}

test("the Dev Core receives an isolated port, state directory, and Pi agent directory", () => {
  const home = resolve("example-home");
  const paths = developmentPaths(home);
  const environment = createDevelopmentEnvironment(home, "workstation", { PATH: "/usr/bin" });

  assert.equal(environment.CINBA_PORT, "4518");
  assert.equal(environment.CINBA_CORE_LIFETIME, "persistent");
  assert.equal(environment.CINBA_DEFAULT_CORE_NAME, "workstation Dev");
  assert.equal(environment.CINBA_STATE_DIR, join(paths.dataDirectory, "Core"));
  assert.equal(environment.CINBA_SYNC_SETTINGS_SOURCE, "sync");
  assert.equal(environment.CINBA_SYNC_CREDENTIAL_SOURCE, "local");
  assert.equal(environment.PI_CODING_AGENT_DIR, join(paths.dataDirectory, "Pi"));
  assert.equal(environment.PATH, "/usr/bin");
});

test("the Dev Core does not inherit stable web search credentials", () => {
  const environment = createDevelopmentEnvironment(resolve("example-home"), "workstation", {
    EXA_API_KEY: "stable-exa-key",
    BRAVE_SEARCH_API_KEY: "stable-brave-key",
    PATH: "/usr/bin",
  });

  assert.equal(environment.EXA_API_KEY, undefined);
  assert.equal(environment.BRAVE_SEARCH_API_KEY, undefined);
  assert.equal(environment.PATH, "/usr/bin");
});

test("Dev Sync uses a state directory and port isolated from stable Sync and Dev Core", () => {
  const home = resolve("example-home");
  const paths = developmentPaths(home);
  const environment = createSyncDevelopmentEnvironment(home, { PATH: "/usr/bin" });
  assert.equal(environment.CINBA_SYNC_STATE_DIR, paths.syncDataDirectory);
  assert.equal(environment.CINBA_SYNC_PORT, "4519");
  assert.equal(environment.CINBA_SYNC_PUBLIC_ORIGIN, "http://127.0.0.1:4519");
  assert.equal(environment.PATH, "/usr/bin");
});

test("each desktop platform uses its native URL opener", () => {
  const url = "http://127.0.0.1:5173/";
  assert.deepEqual(browserOpenCommand(url, "win32"), {
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", url],
  });
  assert.deepEqual(browserOpenCommand(url, "darwin"), { command: "open", args: [url] });
  assert.deepEqual(browserOpenCommand(url, "linux"), { command: "xdg-open", args: [url] });
});
