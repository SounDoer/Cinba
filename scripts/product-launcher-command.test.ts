import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  parseExpectedProductInstallRelease,
  parseStableLauncherCommand,
} from "./product-launcher-command.ts";

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

test("update is owned by the stable launcher", () => {
  assert.deepEqual(parseStableLauncherCommand(["update"], resolve("cinba")), {
    type: "update",
  });
  assert.deepEqual(parseStableLauncherCommand(["update", "--force"], resolve("cinba")), {
    type: "product",
    arguments: ["update", "--force"],
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

test("foreground update handoff accepts only surface, blocking PID, expected version, and TUI cwd", () => {
  const executable = resolve("cinba");
  const project = resolve("project");
  assert.deepEqual(
    parseStableLauncherCommand(["__begin-update-handoff", "desktop", "123", "0.2.0"], executable),
    {
      type: "begin-update-handoff",
      surface: "desktop",
      blockingProcessId: 123,
      expectedVersion: "0.2.0",
    },
  );
  assert.deepEqual(
    parseStableLauncherCommand(
      ["__begin-update-handoff", "tui", "123", "0.2.0", project],
      executable,
    ),
    {
      type: "begin-update-handoff",
      surface: "tui",
      blockingProcessId: 123,
      expectedVersion: "0.2.0",
      workingDirectory: project,
    },
  );
  assert.throws(
    () =>
      parseStableLauncherCommand(
        ["__begin-update-handoff", "tui", "123", "0.2.0", "relative"],
        executable,
      ),
    /invalid foreground update handoff command/,
  );
  assert.throws(
    () =>
      parseStableLauncherCommand(["__begin-update-handoff", "desktop", "123", project], executable),
    /expected version is invalid/,
  );
  assert.throws(
    () =>
      parseStableLauncherCommand(["__begin-update-handoff", "desktop", "0", "0.2.0"], executable),
    /process id must be a positive integer/,
  );
  for (const version of ["", "latest", "../0.2.0", "01.2.0"]) {
    assert.throws(
      () =>
        parseStableLauncherCommand(
          ["__begin-update-handoff", "desktop", "123", version],
          executable,
        ),
      /expected version is invalid/,
    );
  }
});

test("copied update helper accepts only its parent PID", () => {
  const executable = resolve("cinba");
  assert.deepEqual(parseStableLauncherCommand(["__update-handoff-helper", "123"], executable), {
    type: "update-handoff-helper",
    parentProcessId: 123,
  });
  assert.throws(
    () =>
      parseStableLauncherCommand(["__update-handoff-helper", "123", "secret-token"], executable),
    /invalid update handoff helper command/,
  );
});

test("expected update identity is optional for first install and strict when present", () => {
  assert.equal(parseExpectedProductInstallRelease({}), undefined);
  assert.deepEqual(
    parseExpectedProductInstallRelease({
      CINBA_EXPECTED_VERSION: "0.2.0",
      CINBA_EXPECTED_REVISION: "b".repeat(40),
      CINBA_EXPECTED_TARGET: "windows-x64",
    }),
    {
      version: "0.2.0",
      revision: "b".repeat(40),
      target: "windows-x64",
    },
  );
  assert.throws(
    () => parseExpectedProductInstallRelease({ CINBA_EXPECTED_VERSION: "0.2.0" }),
    /identity is invalid/,
  );
});
