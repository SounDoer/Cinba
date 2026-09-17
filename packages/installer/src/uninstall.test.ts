import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { resolveProductPaths } from "./paths.ts";
import { createUninstallPlan } from "./uninstall.ts";

const pathOptions = {
  platform: "win32",
  homeDirectory: "C:\\Users\\cinba-test",
  environment: { LOCALAPPDATA: "C:\\Users\\cinba-test\\AppData\\Local" },
} as const;
const paths = resolveProductPaths(pathOptions);

test("normal uninstall preserves every durable data boundary", () => {
  const plan = createUninstallPlan(pathOptions, { mode: "normal" });
  assert.equal(plan.mode, "normal");
  assert.deepEqual(
    plan.preserved.map((target) => target.path),
    [paths.dataDirectory, paths.configurationDirectory],
  );
  assert.equal(
    plan.targets.some((target) => target.path === paths.dataDirectory),
    false,
  );
  assert.equal(
    plan.targets.some((target) => target.path === paths.syncDataDirectory),
    false,
  );
  assert.equal(
    plan.targets.some((target) => target.path.endsWith(".pi")),
    false,
  );
  assert.equal(
    plan.targets.some((target) => target.path === paths.programDirectory),
    true,
  );
});

test("purge adds only Cinba-owned durable data after dedicated authorization", () => {
  const plan = createUninstallPlan(pathOptions, {
    mode: "purge",
    authorization: { kind: "non-interactive", deleteAllCinbaData: true },
  });
  assert.equal(plan.preserved.length, 0);
  assert.equal(
    plan.targets.some((target) => target.path === paths.dataDirectory),
    true,
  );
  assert.equal(
    plan.targets.some((target) => target.path === paths.configurationDirectory),
    false,
  );
  assert.equal(
    plan.targets.some((target) => target.path === join("C:\\Users\\cinba-test", ".pi")),
    false,
  );
});

test("purge authorization and path resolution fail closed at runtime", () => {
  assert.throws(
    () =>
      createUninstallPlan(pathOptions, {
        mode: "purge",
      } as Parameters<typeof createUninstallPlan>[1]),
    /requires dedicated delete-all-data authorization/,
  );
  assert.throws(
    () => createUninstallPlan({ ...pathOptions, homeDirectory: "." }, { mode: "normal" }),
    /homeDirectory must be an absolute Windows path/,
  );
});
