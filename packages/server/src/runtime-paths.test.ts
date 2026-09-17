import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolveCinbaStateDirectory, resolveWebRoot } from "./runtime-paths.ts";

test("the default Core keeps the existing state directory", () => {
  assert.equal(
    resolveCinbaStateDirectory(undefined, resolve("home")),
    join(resolve("home"), ".cinba"),
  );
});

test("one Core instance may select an isolated absolute state directory", () => {
  const stateDirectory = resolve("home", ".cinba", "dev");
  assert.equal(resolveCinbaStateDirectory(stateDirectory, resolve("unused")), stateDirectory);
});

test("a relative state directory is refused", () => {
  assert.throws(() => resolveCinbaStateDirectory(".cinba/dev", resolve("home")), {
    message: "CINBA_STATE_DIR must be an absolute path",
  });
});

test("a packaged Web root must be explicit and absolute", () => {
  assert.equal(resolveWebRoot(resolve("payload", "web")), resolve("payload", "web"));
  assert.throws(() => resolveWebRoot("relative/web"), {
    message: "CINBA_WEB_ROOT must be an absolute path",
  });
});

test("source development keeps the Web build relative to the server package", () => {
  const workspace = resolve("workspace");
  const moduleUrl = pathToFileURL(join(workspace, "packages", "server", "src", "index.ts")).href;
  assert.equal(resolveWebRoot(undefined, moduleUrl), join(workspace, "packages", "web", "dist"));
});
