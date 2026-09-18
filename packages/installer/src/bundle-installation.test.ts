import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installReleaseBundle } from "./bundle-installation.ts";
import {
  type InstallationLayout,
  readCurrentRelease,
  readInstallationTransaction,
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

test("one bundle transaction activates the payload and commits stable files", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-bundle-install-"));
  const paths = layout(root);
  const events: string[] = [];
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an activation failure rolls stable files back with the payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-bundle-install-rollback-"));
  const events: string[] = [];
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stable-file collision discards the staged candidate so retry is possible", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-bundle-install-stable-failure-"));
  const paths = layout(root);
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
