import assert from "node:assert/strict";
import test from "node:test";
import { createDevelopmentCoreConfig, createDevelopmentSyncEnvironment } from "./development.ts";

const HOME = "C:\\Users\\Ada";
const ENVIRONMENT = { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" };

test("Cinba Dev uses its own native Core data, runtime, logs, Pi, name, and port", () => {
  const config = createDevelopmentCoreConfig("C:\\Code\\Cinba", {
    platform: "win32",
    homeDirectory: HOME,
    environment: ENVIRONMENT,
    machineName: "workstation",
  });
  assert.equal(config.baseUrl, "http://127.0.0.1:4527/");
  assert.equal(config.stateDirectory, "C:\\Users\\Ada\\AppData\\Local\\Cinba Dev\\Data\\Core");
  assert.equal(config.piAgentDirectory, "C:\\Users\\Ada\\AppData\\Local\\Cinba Dev\\Data\\Pi");
  assert.equal(
    config.runtimePath,
    "C:\\Users\\Ada\\AppData\\Local\\Cinba Dev\\State\\core-runtime.json",
  );
  assert.equal(config.logPath, "C:\\Users\\Ada\\AppData\\Local\\Cinba Dev\\Logs\\core.log");
  assert.equal(config.defaultCoreName, "workstation Dev");
});

test("Cinba Dev Sync shares the Dev identity but keeps its own authority subtree", () => {
  const environment = createDevelopmentSyncEnvironment({
    platform: "win32",
    homeDirectory: HOME,
    environment: ENVIRONMENT,
  });
  assert.equal(environment.CINBA_SYNC_PORT, "4528");
  assert.equal(environment.CINBA_SYNC_PUBLIC_ORIGIN, "http://127.0.0.1:4528");
  assert.equal(
    environment.CINBA_SYNC_STATE_DIR,
    "C:\\Users\\Ada\\AppData\\Local\\Cinba Dev\\Data\\Sync",
  );
});
