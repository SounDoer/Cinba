import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveCinbaStateDirectory } from "./runtime-paths.ts";

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
