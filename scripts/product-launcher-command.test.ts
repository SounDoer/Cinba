import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { parseStableLauncherCommand } from "./product-launcher-command.ts";

test("the bundle launcher infers its bundle root for installation", () => {
  assert.deepEqual(
    parseStableLauncherCommand(["install"], resolve("bundle", "launcher", "cinba")),
    { type: "install", bundleDirectory: resolve("bundle") },
  );
});

test("ordinary arguments remain owned by the active product CLI", () => {
  assert.deepEqual(parseStableLauncherCommand(["tui", "project"], resolve("cinba")), {
    type: "product",
    arguments: ["tui", "project"],
  });
});
