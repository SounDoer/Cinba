import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { type ResolveProductPathsOptions, resolveProductPaths } from "./paths.ts";
import { createUninstallPlan, executeUninstallPlan } from "./uninstall.ts";

const pathOptions = {
  platform: "win32",
  homeDirectory: "C:\\Users\\cinba-test",
  environment: { LOCALAPPDATA: "C:\\Users\\cinba-test\\AppData\\Local" },
} as const;
const paths = resolveProductPaths(pathOptions);

function nativePathOptions(root: string): ResolveProductPathsOptions {
  if (
    process.platform !== "win32" &&
    process.platform !== "darwin" &&
    process.platform !== "linux"
  ) {
    throw new Error(`unsupported test platform: ${process.platform}`);
  }
  return {
    platform: process.platform,
    homeDirectory: root,
    environment: process.platform === "win32" ? { LOCALAPPDATA: join(root, "LocalAppData") } : {},
  };
}

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

test("macOS normal uninstall includes release storage outside the application", () => {
  const macPaths = resolveProductPaths({
    platform: "darwin",
    homeDirectory: "/Users/ada",
    environment: {},
  });
  const plan = createUninstallPlan(
    { platform: "darwin", homeDirectory: "/Users/ada", environment: {} },
    { mode: "normal" },
  );
  assert.equal(
    plan.targets.some(
      (target) => target.kind === "release-storage" && target.path === macPaths.releasesDirectory,
    ),
    true,
  );
});

test("normal uninstall executes every owned target while preserving durable data", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-uninstall-execute-"));
  const options = nativePathOptions(root);
  const plan = createUninstallPlan(options, { mode: "normal" });
  const productPaths = resolveProductPaths(options);
  try {
    for (const target of plan.targets) {
      await mkdir(target.kind === "launcher" ? dirname(target.path) : target.path, {
        recursive: true,
      });
      if (target.kind === "launcher") {
        await writeFile(target.path, "launcher");
      } else {
        await writeFile(join(target.path, "owned.txt"), target.kind);
      }
    }
    await mkdir(productPaths.dataDirectory, { recursive: true });
    await writeFile(join(productPaths.dataDirectory, "preserved.txt"), "user data");

    const result = await executeUninstallPlan(plan);
    assert.deepEqual(result.failed, []);
    assert.equal(result.removed.length, plan.targets.length);
    assert.equal(
      await readFile(join(productPaths.dataDirectory, "preserved.txt"), "utf8"),
      "user data",
    );
    await assert.rejects(readFile(productPaths.launcherPath, "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstall continues through bounded failures and releases state before the launcher", async () => {
  const calls: string[] = [];
  const plan = {
    schemaVersion: 1 as const,
    identity: "release" as const,
    mode: "normal" as const,
    targets: [
      { kind: "launcher" as const, path: join(process.cwd(), "launcher") },
      { kind: "runtime-state" as const, path: join(process.cwd(), "state") },
      { kind: "program" as const, path: join(process.cwd(), "program") },
      { kind: "cache" as const, path: join(process.cwd(), "cache") },
    ],
    preserved: [],
  };
  const result = await executeUninstallPlan(plan, async (path) => {
    calls.push(path.toString());
    if (path.toString().endsWith("program")) {
      throw new Error("busy");
    }
  });
  assert.deepEqual(calls, [
    join(process.cwd(), "program"),
    join(process.cwd(), "cache"),
    join(process.cwd(), "state"),
    join(process.cwd(), "launcher"),
  ]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.removed.length, 3);
});
