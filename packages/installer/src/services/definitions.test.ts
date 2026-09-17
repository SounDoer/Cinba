import assert from "node:assert/strict";
import test from "node:test";
import { resolveProductPaths } from "../paths.ts";
import { createManagedServiceDefinitions } from "./definitions.ts";

test("Core and Sync use separate registrations through one stable launcher", () => {
  const paths = resolveProductPaths({
    platform: "win32",
    homeDirectory: "C:\\Users\\cinba-test",
    environment: { LOCALAPPDATA: "C:\\Users\\cinba-test\\AppData\\Local" },
  });
  const services = createManagedServiceDefinitions(paths, "win32");
  assert.notEqual(services.core.registrationId, services.sync.registrationId);
  assert.equal(services.core.launcherPath, paths.launcherPath);
  assert.equal(services.sync.launcherPath, paths.launcherPath);
  assert.equal(services.core.launcherPath.includes("releases"), false);
  assert.deepEqual(services.core.arguments, ["service", "core"]);
  assert.deepEqual(services.sync.arguments, ["service", "sync"]);
  assert.deepEqual(services.core.allowedModes, ["on-demand", "background"]);
  assert.deepEqual(services.sync.allowedModes, ["disabled", "on-demand", "background"]);
});

test("each platform receives its native registration identity", () => {
  const windows = resolveProductPaths({
    platform: "win32",
    homeDirectory: "C:\\Users\\cinba-test",
  });
  const macos = resolveProductPaths({
    platform: "darwin",
    homeDirectory: "/Users/cinba-test",
  });
  const linux = resolveProductPaths({
    platform: "linux",
    homeDirectory: "/home/cinba-test",
  });
  assert.equal(
    createManagedServiceDefinitions(windows, "win32").core.registrationId,
    "\\Cinba\\Core",
  );
  assert.equal(
    createManagedServiceDefinitions(macos, "darwin").sync.registrationId,
    "com.soundoer.cinba.sync",
  );
  assert.equal(
    createManagedServiceDefinitions(linux, "linux").core.registrationId,
    "cinba-core.service",
  );
});
