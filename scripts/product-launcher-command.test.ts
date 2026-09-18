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

test("uninstall has distinct normal, interactive purge, and automation authorization forms", () => {
  const executable = resolve("cinba");
  assert.deepEqual(parseStableLauncherCommand(["uninstall"], executable), {
    type: "uninstall",
    purge: false,
    deleteAllCinbaData: false,
  });
  assert.deepEqual(parseStableLauncherCommand(["uninstall", "--purge"], executable), {
    type: "uninstall",
    purge: true,
    deleteAllCinbaData: false,
  });
  assert.deepEqual(
    parseStableLauncherCommand(["uninstall", "--purge", "--delete-all-cinba-data"], executable),
    { type: "uninstall", purge: true, deleteAllCinbaData: true },
  );
  assert.deepEqual(parseStableLauncherCommand(["uninstall", "--force"], executable), {
    type: "product",
    arguments: ["uninstall", "--force"],
  });
});

test("the copied launcher recognizes only a bounded uninstall helper command", () => {
  assert.deepEqual(
    parseStableLauncherCommand(["__uninstall-helper", "123", "normal"], resolve("cinba")),
    { type: "uninstall-helper", parentProcessId: 123, purge: false },
  );
  assert.deepEqual(
    parseStableLauncherCommand(["__uninstall-helper", "123", "purge"], resolve("cinba")),
    { type: "uninstall-helper", parentProcessId: 123, purge: true },
  );
  assert.deepEqual(
    parseStableLauncherCommand(["__uninstall-helper", "0", "purge"], resolve("cinba")),
    { type: "product", arguments: ["__uninstall-helper", "0", "purge"] },
  );
});
