import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { browserOpenCommand, createDevelopmentEnvironment } from "./launch.ts";

test("the Dev Core receives an isolated port, state directory, and Pi agent directory", () => {
  const home = resolve("example-home");
  const stateDirectory = join(home, ".cinba", "dev");
  const environment = createDevelopmentEnvironment(home, "workstation", { PATH: "/usr/bin" });

  assert.equal(environment.CINBA_PORT, "4518");
  assert.equal(environment.CINBA_CORE_LIFETIME, "persistent");
  assert.equal(environment.CINBA_DEFAULT_CORE_NAME, "workstation Dev");
  assert.equal(environment.CINBA_STATE_DIR, stateDirectory);
  assert.equal(environment.PI_CODING_AGENT_DIR, join(stateDirectory, "pi-agent"));
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
