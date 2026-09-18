import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProductPaths } from "./paths.ts";
import type { VerifiedReleaseBundle } from "./release-bundle.ts";
import { prepareStableProductFiles, recoverStableProductFiles } from "./stable-files.ts";

function paths(root: string, desktop: boolean): ProductPaths {
  const programDirectory = join(root, "program");
  return {
    identity: "release",
    applicationId: "com.soundoer.cinba",
    programDirectory,
    releasesDirectory: join(programDirectory, "releases"),
    managerDirectory: join(programDirectory, "installer"),
    currentPointerDirectory: programDirectory,
    dataDirectory: join(root, "data"),
    syncDataDirectory: join(root, "data", "Sync"),
    configurationDirectory: join(root, "config"),
    stateDirectory: join(root, "state"),
    transactionDirectory: join(root, "state", "install"),
    cacheDirectory: join(root, "cache"),
    logDirectory: join(root, "logs"),
    launcherDirectory: join(programDirectory, "bin"),
    launcherPath: join(programDirectory, "bin", "cinba.exe"),
    desktopApplicationPath: desktop ? join(programDirectory, "desktop", "Cinba.exe") : null,
  };
}

async function bundle(root: string, desktop: boolean): Promise<VerifiedReleaseBundle> {
  const bundleRoot = join(root, "bundle");
  const launcher = join(bundleRoot, "launcher", "cinba.exe");
  await mkdir(join(bundleRoot, "launcher"), { recursive: true });
  await writeFile(launcher, "new launcher");
  let desktopApplication: string | null = null;
  if (desktop) {
    desktopApplication = join(bundleRoot, "desktop", "Cinba.exe");
    await mkdir(join(bundleRoot, "desktop", "resources"), { recursive: true });
    await writeFile(desktopApplication, "new desktop");
    await writeFile(join(bundleRoot, "desktop", "resources", "app.asar"), "resources");
  }
  return {
    rootDirectory: bundleRoot,
    payloadDirectory: join(bundleRoot, "payload"),
    launcher,
    desktopApplication,
    metadata: {
      schemaVersion: 1,
      product: "Cinba",
      version: "0.1.0",
      revision: "a".repeat(40),
      target: desktop ? "windows-x64" : "linux-x64-gnu",
      kind: desktop ? "desktop" : "headless",
    },
    payload: undefined!,
    inventory: undefined!,
  };
}

test("a first Desktop install places the whole application and launcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-stable-create-"));
  const productPaths = paths(root, true);
  try {
    const prepared = await prepareStableProductFiles({
      bundle: await bundle(root, true),
      paths: productPaths,
      mode: "create",
    });
    assert.equal(await readFile(productPaths.launcherPath, "utf8"), "new launcher");
    assert.equal(await readFile(productPaths.desktopApplicationPath!, "utf8"), "new desktop");
    assert.equal(
      await readFile(
        join(productPaths.programDirectory, "desktop", "resources", "app.asar"),
        "utf8",
      ),
      "resources",
    );
    await prepared.commit();
    for (const directory of [productPaths.programDirectory, productPaths.launcherDirectory]) {
      assert.deepEqual(
        (await readdir(directory)).filter((name) => name.includes("cinba-")),
        [],
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a macOS installer can replace itself from its embedded bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-stable-macos-self-install-"));
  const desktopApplicationPath = join(root, "Applications", "Cinba.app");
  const bundleRoot = join(desktopApplicationPath, "Contents", "Resources", "cinba-bundle");
  const launcher = join(bundleRoot, "launcher", "cinba");
  const stableApplication = join(bundleRoot, "desktop", "Cinba.app");
  const productPaths = {
    ...paths(root, true),
    programDirectory: desktopApplicationPath,
    desktopApplicationPath,
    launcherDirectory: join(root, ".local", "bin"),
    launcherPath: join(root, ".local", "bin", "cinba"),
  };
  try {
    await mkdir(join(stableApplication, "Contents"), { recursive: true });
    await mkdir(join(bundleRoot, "launcher"), { recursive: true });
    await writeFile(join(desktopApplicationPath, "installer.txt"), "outer installer");
    await writeFile(join(stableApplication, "Contents", "stable.txt"), "stable application");
    await writeFile(launcher, "stable launcher");
    const prepared = await prepareStableProductFiles({
      bundle: {
        ...(await bundle(root, false)),
        rootDirectory: bundleRoot,
        launcher,
        desktopApplication: stableApplication,
        metadata: {
          schemaVersion: 1,
          product: "Cinba",
          version: "0.1.0",
          revision: "a".repeat(40),
          target: "macos-arm64",
          kind: "desktop",
        },
      },
      paths: productPaths,
      mode: "replace",
    });
    assert.equal(
      await readFile(join(desktopApplicationPath, "Contents", "stable.txt"), "utf8"),
      "stable application",
    );
    assert.equal(await readFile(productPaths.launcherPath, "utf8"), "stable launcher");
    await prepared.commit();
    await assert.rejects(readFile(join(desktopApplicationPath, "installer.txt"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("create mode refuses an occupied launcher and removes the prepared Desktop", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-stable-collision-"));
  const productPaths = paths(root, true);
  try {
    await mkdir(productPaths.launcherDirectory, { recursive: true });
    await writeFile(productPaths.launcherPath, "someone else's command");
    await assert.rejects(
      prepareStableProductFiles({
        bundle: await bundle(root, true),
        paths: productPaths,
        mode: "create",
      }),
      /destination already exists/,
    );
    await assert.rejects(readFile(productPaths.desktopApplicationPath!, "utf8"), /ENOENT/);
    assert.equal(await readFile(productPaths.launcherPath, "utf8"), "someone else's command");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an update rollback restores both stable application and launcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-stable-rollback-"));
  const productPaths = paths(root, true);
  try {
    await mkdir(join(productPaths.programDirectory, "desktop"), { recursive: true });
    await mkdir(productPaths.launcherDirectory, { recursive: true });
    await writeFile(productPaths.desktopApplicationPath!, "old desktop");
    await writeFile(productPaths.launcherPath, "old launcher");
    const prepared = await prepareStableProductFiles({
      bundle: await bundle(root, true),
      paths: productPaths,
      mode: "replace",
    });
    assert.equal(await readFile(productPaths.desktopApplicationPath!, "utf8"), "new desktop");
    assert.equal(await readFile(productPaths.launcherPath, "utf8"), "new launcher");
    await prepared.rollback();
    assert.equal(await readFile(productPaths.desktopApplicationPath!, "utf8"), "old desktop");
    assert.equal(await readFile(productPaths.launcherPath, "utf8"), "old launcher");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a headless install places only the stable launcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-stable-headless-"));
  const productPaths = paths(root, false);
  try {
    const prepared = await prepareStableProductFiles({
      bundle: await bundle(root, false),
      paths: productPaths,
      mode: "create",
    });
    await prepared.commit();
    assert.equal(await readFile(productPaths.launcherPath, "utf8"), "new launcher");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupted stable-file preparation can be rolled back deterministically", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-stable-recovery-"));
  const productPaths = paths(root, true);
  try {
    await mkdir(join(productPaths.programDirectory, "desktop"), { recursive: true });
    await mkdir(productPaths.launcherDirectory, { recursive: true });
    await writeFile(productPaths.desktopApplicationPath!, "old desktop");
    await writeFile(productPaths.launcherPath, "old launcher");
    await prepareStableProductFiles({
      bundle: await bundle(root, true),
      paths: productPaths,
      mode: "replace",
    });

    await recoverStableProductFiles({
      target: "windows-x64",
      paths: productPaths,
      mode: "replace",
      outcome: "rollback",
    });
    assert.equal(await readFile(productPaths.desktopApplicationPath!, "utf8"), "old desktop");
    assert.equal(await readFile(productPaths.launcherPath, "utf8"), "old launcher");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
