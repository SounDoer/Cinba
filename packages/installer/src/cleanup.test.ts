import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import { cleanupInstallation } from "./cleanup.ts";
import {
  type InstallationLayout,
  writeCurrentRelease,
  writeInstallationTransaction,
} from "./installation-store.ts";

const OLD_REVISION = "1111111111111111111111111111111111111111";
const NEW_REVISION = "2222222222222222222222222222222222222222";
const TRANSACTION_ID = "11111111-1111-4111-8111-111111111111";

function layout(root: string): InstallationLayout {
  return {
    programDirectory: join(root, "program"),
    releasesDirectory: join(root, "program", "releases"),
    transactionDirectory: join(root, "state", "install"),
  };
}

function release(revision: string) {
  return {
    version: revision === OLD_REVISION ? "1.0.0" : "2.0.0",
    revision,
    protocolVersion: 1,
    dataFormatVersion: 1,
    target: "windows-x64" as const,
    directory: revision,
  };
}

test("cleanup removes only known inactive release storage", async (t) => {
  const root = temporaryDirectory("cinba-install-cleanup-", t);
  const paths = layout(root);
  const current = release(NEW_REVISION);
  const candidateName = `.${OLD_REVISION}.${TRANSACTION_ID}.candidate`;
  const replacementName = `.${NEW_REVISION}.${TRANSACTION_ID}.replaced`;
  for (const name of [OLD_REVISION, NEW_REVISION, candidateName, replacementName, "keep-me"]) {
    await mkdir(join(paths.releasesDirectory, name), { recursive: true });
    await writeFile(join(paths.releasesDirectory, name, "marker.txt"), name);
  }
  await writeCurrentRelease(paths, current);
  await writeInstallationTransaction(paths, {
    schemaVersion: 1,
    id: TRANSACTION_ID,
    phase: "committed",
    candidate: {
      ...release(NEW_REVISION),
      directory: `.${NEW_REVISION}.${TRANSACTION_ID}.candidate`,
    },
    previous: release(OLD_REVISION),
    startedAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:01:00.000Z",
    failure: null,
  });

  const result = await cleanupInstallation(paths);
  assert.equal(result.failed.length, 0);
  assert.equal(result.removed.length, 3);
  assert.equal(
    await readFile(join(paths.releasesDirectory, NEW_REVISION, "marker.txt"), "utf8"),
    NEW_REVISION,
  );
  assert.equal(
    await readFile(join(paths.releasesDirectory, "keep-me", "marker.txt"), "utf8"),
    "keep-me",
  );
  await assert.rejects(readFile(join(paths.releasesDirectory, OLD_REVISION, "marker.txt")), {
    code: "ENOENT",
  });
});

test("cleanup refuses to race a nonterminal installation", async (t) => {
  const root = temporaryDirectory("cinba-install-cleanup-active-", t);
  const paths = layout(root);
  await writeInstallationTransaction(paths, {
    schemaVersion: 1,
    id: TRANSACTION_ID,
    phase: "switching",
    candidate: {
      ...release(NEW_REVISION),
      directory: `.${NEW_REVISION}.${TRANSACTION_ID}.candidate`,
    },
    previous: release(OLD_REVISION),
    startedAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:01:00.000Z",
    failure: null,
  });
  await assert.rejects(cleanupInstallation(paths), /is still switching/);
});
