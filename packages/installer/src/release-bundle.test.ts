import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import { createArtifactInventory } from "./inventory.ts";
import { parseReleaseBundleMetadata, verifyReleaseBundle } from "./release-bundle.ts";

const revision = "a".repeat(40);
const identity = { version: "0.1.0", revision, target: "windows-x64" as const };

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function createBundle(t: TestContext): Promise<string> {
  const root = temporaryDirectory("cinba-release-bundle-", t);
  const payload = join(root, "payload");
  await mkdir(join(root, "desktop"), { recursive: true });
  await mkdir(join(root, "launcher"), { recursive: true });
  await mkdir(join(payload, "lib"), { recursive: true });
  await writeFile(join(root, "desktop", "Cinba.exe"), "desktop-shell");
  await writeFile(join(root, "launcher", "cinba.exe"), "launcher");
  await writeFile(join(payload, "lib", "cli.mjs"), "console.log('Cinba')");
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
  await writeJson(join(root, "bundle.json"), {
    schemaVersion: 1,
    product: "Cinba",
    ...identity,
    kind: "desktop",
  });
  await writeJson(
    join(root, "bundle-inventory.json"),
    await createArtifactInventory(root, identity, { inventoryFileName: "bundle-inventory.json" }),
  );
  return root;
}

test("a release bundle binds its shell and payload to one verified identity", async (t) => {
  const root = await createBundle(t);
  const bundle = await verifyReleaseBundle(root, "windows-x64");
  assert.equal(bundle.metadata.kind, "desktop");
  assert.equal(bundle.payloadDirectory, join(root, "payload"));
  assert.equal(bundle.launcher, join(root, "launcher", "cinba.exe"));
  assert.equal(bundle.desktopApplication, join(root, "desktop", "Cinba.exe"));
});

test("a release bundle rejects damage before exposing the payload", async (t) => {
  const root = await createBundle(t);
  await writeFile(join(root, "payload", "lib", "cli.mjs"), "damaged");
  await assert.rejects(() => verifyReleaseBundle(root, "windows-x64"), {
    message: /release bundle inventory verification failed/,
  });
});

test("Desktop and Headless bundle kinds are fixed by target", () => {
  assert.throws(
    () =>
      parseReleaseBundleMetadata({
        schemaVersion: 1,
        product: "Cinba",
        ...identity,
        kind: "headless",
      }),
    { message: "release bundle windows-x64 must use kind desktop" },
  );
});
