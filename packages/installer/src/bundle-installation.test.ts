import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import { installReleaseBundle } from "./bundle-installation.ts";
import { acquireInstallationLock } from "./installation-lock.ts";
import {
  type InstallationLayout,
  readCurrentRelease,
  readInstallationTransaction,
  writeInstallationTransaction,
} from "./installation-store.ts";
import { createArtifactInventory } from "./inventory.ts";

const revision = "b".repeat(40);
const transactionId = "12345678-1234-4234-8234-123456789abc";
const identity = { version: "0.1.0", revision, target: "windows-x64" as const };

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function layout(root: string): InstallationLayout {
  return {
    programDirectory: join(root, "program"),
    releasesDirectory: join(root, "program", "releases"),
    transactionDirectory: join(root, "state", "install"),
  };
}

async function createBundle(root: string): Promise<string> {
  const bundle = join(root, "bundle");
  const payload = join(bundle, "payload");
  await mkdir(join(bundle, "desktop"), { recursive: true });
  await mkdir(join(bundle, "launcher"), { recursive: true });
  await mkdir(join(payload, "lib"), { recursive: true });
  await writeFile(join(bundle, "desktop", "Cinba.exe"), "desktop");
  await writeFile(join(bundle, "launcher", "cinba.exe"), "launcher");
  await writeFile(join(payload, "lib", "cli.mjs"), "cli");
  await writeJson(join(payload, "release.json"), {
    schemaVersion: 1,
    product: "Cinba",
    ...identity,
    protocolVersion: 1,
    dataFormatVersion: 1,
    nodeVersion: "24.0.0",
  });
  await writeJson(
    join(payload, "inventory.json"),
    await createArtifactInventory(payload, identity),
  );
  await writeJson(join(bundle, "bundle.json"), {
    schemaVersion: 1,
    product: "Cinba",
    ...identity,
    kind: "desktop",
  });
  await writeJson(
    join(bundle, "bundle-inventory.json"),
    await createArtifactInventory(bundle, identity, {
      inventoryFileName: "bundle-inventory.json",
    }),
  );
  return bundle;
}

test("one bundle transaction activates the payload and commits stable files", async (t) => {
  const root = temporaryDirectory("cinba-bundle-install-", t);
  const paths = layout(root);
  const events: string[] = [];
  const bundle = await createBundle(root);
  const transaction = await installReleaseBundle({
    bundleDirectory: bundle,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId,
    prepareStableFiles: async (verified) => {
      assert.equal(verified.launcher, join(bundle, "launcher", "cinba.exe"));
      events.push("prepare");
      return {
        commit: async () => void events.push("commit"),
        rollback: async () => void events.push("rollback"),
      };
    },
  });
  assert.equal(transaction.phase, "committed");
  assert.deepEqual(events, ["prepare", "commit"]);
  assert.equal((await readCurrentRelease(paths))?.revision, revision);
});

test("a bundle installation reports each step before it starts", async (t) => {
  const root = temporaryDirectory("cinba-bundle-install-progress-", t);
  const progress: string[] = [];
  await installReleaseBundle({
    bundleDirectory: await createBundle(root),
    layout: layout(root),
    expectedTarget: "windows-x64",
    transactionId,
    report: (phase) => void progress.push(phase),
  });
  assert.deepEqual(progress, ["checking-package", "preparing", "copying-payload", "activating"]);
});

test("an activation failure rolls stable files back with the payload", async (t) => {
  const root = temporaryDirectory("cinba-bundle-install-rollback-", t);
  const events: string[] = [];
  const bundle = await createBundle(root);
  await assert.rejects(() =>
    installReleaseBundle({
      bundleDirectory: bundle,
      layout: layout(root),
      expectedTarget: "windows-x64",
      transactionId,
      verify: async () => {
        throw new Error("probe failed");
      },
      prepareStableFiles: async () => {
        events.push("prepare");
        return {
          commit: async () => void events.push("commit"),
          rollback: async () => void events.push("rollback"),
        };
      },
    }),
  );
  assert.deepEqual(events, ["prepare", "rollback"]);
  assert.equal(await readCurrentRelease(layout(root)), undefined);
});

test("a stable-file collision discards the staged candidate so retry is possible", async (t) => {
  const root = temporaryDirectory("cinba-bundle-install-stable-failure-", t);
  const paths = layout(root);
  const bundle = await createBundle(root);
  await assert.rejects(
    installReleaseBundle({
      bundleDirectory: bundle,
      layout: paths,
      expectedTarget: "windows-x64",
      transactionId,
      prepareStableFiles: async () => {
        throw new Error("launcher collision");
      },
    }),
    /launcher collision/,
  );
  assert.equal((await readInstallationTransaction(paths))?.failure, "stable-files-failed");
  assert.equal(await readCurrentRelease(paths), undefined);
});

test("an expected release mismatch fails before staging or stable file changes", async (t) => {
  const root = temporaryDirectory("cinba-bundle-install-identity-", t);
  const paths = layout(root);
  let prepared = false;
  const bundle = await createBundle(root);
  await assert.rejects(
    installReleaseBundle({
      bundleDirectory: bundle,
      layout: paths,
      expectedTarget: "windows-x64",
      expectedRelease: {
        version: "0.2.0",
        revision: "c".repeat(40),
        target: "windows-x64",
      },
      prepareStableFiles: async () => {
        prepared = true;
        throw new Error("must not prepare stable files");
      },
    }),
    /does not match the expected release/,
  );
  assert.equal(prepared, false);
  assert.equal(await readInstallationTransaction(paths), undefined);
  assert.equal(await readCurrentRelease(paths), undefined);
});

test("rerunning the installer repairs a staging transaction left by a dead installer", async (t) => {
  const root = temporaryDirectory("cinba-bundle-install-stale-staging-", t);
  const paths = layout(root);
  const staleId = "87654321-4321-4321-8321-cba987654321";
  const staleCandidate = join(paths.releasesDirectory, `.${revision}.${staleId}.candidate`);
  const bundle = await createBundle(root);
  await mkdir(staleCandidate, { recursive: true });
  await writeFile(join(staleCandidate, "partial.txt"), "partial");
  await writeInstallationTransaction(paths, {
    schemaVersion: 1,
    id: staleId,
    phase: "staging",
    candidate: {
      ...identity,
      protocolVersion: 1,
      dataFormatVersion: 1,
      directory: `.${revision}.${staleId}.candidate`,
    },
    previous: null,
    startedAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    failure: null,
  });
  // The dead installer's lock is left behind as well.
  await acquireInstallationLock(paths, { processId: 2_147_483_647 });

  const transaction = await installReleaseBundle({
    bundleDirectory: bundle,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId,
  });
  assert.equal(transaction.phase, "committed");
  assert.equal((await readCurrentRelease(paths))?.revision, revision);
  await assert.rejects(readFile(join(staleCandidate, "partial.txt")), { code: "ENOENT" });
});

test("a disposable bundle gives up its payload instead of having it copied", async (t) => {
  const root = temporaryDirectory("cinba-bundle-install-consume-", t);
  const paths = layout(root);
  const bundle = await createBundle(root);
  const transaction = await installReleaseBundle({
    bundleDirectory: bundle,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId,
    consumeBundle: true,
    // Stable files come from the bundle's launcher and desktop directories, which a consumed
    // payload leaves untouched.
    prepareStableFiles: async (verified) => {
      assert.equal(
        await readFile(join(verified.rootDirectory, "launcher", "cinba.exe"), "utf8"),
        "launcher",
      );
      return { commit: async () => {}, rollback: async () => {} };
    },
  });
  assert.equal(transaction.phase, "committed");
  assert.equal(
    await readFile(join(paths.releasesDirectory, revision, "lib", "cli.mjs"), "utf8"),
    "cli",
  );
  await assert.rejects(readFile(join(bundle, "payload", "release.json"), "utf8"), {
    code: "ENOENT",
  });
});
