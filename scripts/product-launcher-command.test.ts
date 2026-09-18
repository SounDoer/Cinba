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

test("the copied launcher accepts only a bounded update helper handoff", () => {
  const artifact = resolve("cache", "Cinba-0.2.0-windows-x64.exe");
  const sha256 = "a".repeat(64);
  const revision = "b".repeat(40);
  const leaseToken = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(
    parseStableLauncherCommand(
      ["__update-helper", "123", leaseToken, artifact, "0.2.0", revision, sha256],
      resolve("cinba"),
    ),
    {
      type: "update-helper",
      parentProcessId: 123,
      leaseToken,
      artifactPath: artifact,
      version: "0.2.0",
      revision,
      sha256,
    },
  );
  assert.deepEqual(
    parseStableLauncherCommand(
      ["__update-helper", "0", leaseToken, artifact, "0.2.0", revision, sha256],
      resolve("cinba"),
    ),
    {
      type: "product",
      arguments: ["__update-helper", "0", leaseToken, artifact, "0.2.0", revision, sha256],
    },
  );
  assert.deepEqual(
    parseStableLauncherCommand(
      ["__update-helper", "123", leaseToken, "relative.exe", "0.2.0", revision, sha256],
      resolve("cinba"),
    ),
    {
      type: "product",
      arguments: ["__update-helper", "123", leaseToken, "relative.exe", "0.2.0", revision, sha256],
    },
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
