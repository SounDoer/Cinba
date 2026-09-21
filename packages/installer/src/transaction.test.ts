import assert from "node:assert/strict";
import { mkdir, readFile, readlink, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import { createDataSnapshot } from "./data-snapshot.ts";
import { createArtifactInventory } from "./inventory.ts";
import { acquireInstallationLock, waitForInstallationIdle } from "./installation-lock.ts";
import {
  type InstallationLayout,
  readCurrentRelease,
  readInstallationTransaction,
  releasePath,
  writeCurrentRelease,
  writeInstallationTransaction,
} from "./installation-store.ts";
import {
  activateCandidate,
  recoverInterruptedInstallation,
  stageCandidate,
} from "./transaction.ts";

const OLD_REVISION = "1111111111111111111111111111111111111111";
const NEW_REVISION = "2222222222222222222222222222222222222222";
const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";

function layout(root: string): InstallationLayout {
  return {
    programDirectory: join(root, "program"),
    releasesDirectory: join(root, "program", "releases"),
    transactionDirectory: join(root, "state", "install"),
  };
}

async function artifact(
  root: string,
  name: string,
  version: string,
  revision: string,
  content = version,
  dataFormatVersion = 1,
): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "app.txt"), content);
  await writeFile(
    join(directory, "release.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        product: "Cinba",
        version,
        revision,
        protocolVersion: 1,
        dataFormatVersion,
        target: "windows-x64",
        nodeVersion: "24.0.0",
      },
      null,
      2,
    )}\n`,
  );
  const inventory = await createArtifactInventory(directory, {
    version,
    revision,
    target: "windows-x64",
  });
  await writeFile(join(directory, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
  return directory;
}

test("a verified candidate stages without changing the current release", async (t) => {
  const root = temporaryDirectory("cinba-stage-", t);
  const paths = layout(root);
  const source = await artifact(root, "source", "1.0.0", OLD_REVISION);
  const transaction = await stageCandidate({
    sourceDirectory: source,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: FIRST_ID,
  });
  assert.equal(transaction.phase, "ready");
  assert.equal(await readCurrentRelease(paths), undefined);
  assert.equal(
    await readFile(join(releasePath(paths, transaction.candidate), "app.txt"), "utf8"),
    "1.0.0",
  );
});

test("a bundled macOS candidate may stage from inside the application directory", async (t) => {
  const root = temporaryDirectory("cinba-stage-macos-bundle-", t);
  const paths = {
    ...layout(root),
    releasesDirectory: join(root, "state", "releases"),
  };
  const source = await artifact(paths.programDirectory, "embedded", "1.0.0", OLD_REVISION);
  const transaction = await stageCandidate({
    sourceDirectory: source,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: FIRST_ID,
  });
  assert.equal(transaction.phase, "ready");
});

test("a staged macOS candidate keeps relative symbolic links independent of its source", async (t) => {
  if (process.platform === "win32") {
    t.skip("release symlinks exist only in macOS artifacts");
    return;
  }
  const root = temporaryDirectory("cinba-stage-macos-links-", t);
  const paths = layout(root);
  const source = join(root, "source");
  await mkdir(join(source, "framework"), { recursive: true });
  await writeFile(join(source, "framework", "binary"), "framework binary");
  await symlink("binary", join(source, "framework", "Current"));
  await writeFile(
    join(source, "release.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        product: "Cinba",
        version: "1.0.0",
        revision: OLD_REVISION,
        protocolVersion: 1,
        dataFormatVersion: 1,
        target: "macos-arm64",
        nodeVersion: "24.0.0",
      },
      null,
      2,
    )}\n`,
  );
  const inventory = await createArtifactInventory(source, {
    version: "1.0.0",
    revision: OLD_REVISION,
    target: "macos-arm64",
  });
  await writeFile(join(source, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);

  const transaction = await stageCandidate({
    sourceDirectory: source,
    layout: paths,
    expectedTarget: "macos-arm64",
    transactionId: FIRST_ID,
  });

  assert.equal(
    await readlink(join(releasePath(paths, transaction.candidate), "framework", "Current")),
    "binary",
  );
});

test("a candidate cannot stage recursively from managed release storage", async (t) => {
  const root = temporaryDirectory("cinba-stage-managed-release-", t);
  const paths = layout(root);
  const source = await artifact(paths.releasesDirectory, "embedded", "1.0.0", OLD_REVISION);
  await assert.rejects(
    stageCandidate({
      sourceDirectory: source,
      layout: paths,
      expectedTarget: "windows-x64",
      transactionId: FIRST_ID,
    }),
    /candidate sourceDirectory must be outside the managed releases directory/,
  );
});

test("a damaged candidate never changes current", async (t) => {
  const root = temporaryDirectory("cinba-stage-damaged-", t);
  const paths = layout(root);
  const source = await artifact(root, "source", "1.0.0", OLD_REVISION);
  await writeFile(join(source, "app.txt"), "tampered");
  await assert.rejects(
    stageCandidate({
      sourceDirectory: source,
      layout: paths,
      expectedTarget: "windows-x64",
      transactionId: FIRST_ID,
    }),
    /candidate inventory verification failed/,
  );
  assert.equal(await readCurrentRelease(paths), undefined);
  assert.equal(await readInstallationTransaction(paths), undefined);
});

test("an older release cannot replace data written in a newer format", async (t) => {
  const root = temporaryDirectory("cinba-data-downgrade-", t);
  const paths = layout(root);
  const current = await artifact(root, "current", "2.0.0", NEW_REVISION, "new", 2);
  await stageCandidate({
    sourceDirectory: current,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: FIRST_ID,
  });
  await activateCandidate({ layout: paths });

  const old = await artifact(root, "old", "1.0.0", OLD_REVISION, "old", 1);
  await assert.rejects(
    stageCandidate({
      sourceDirectory: old,
      layout: paths,
      expectedTarget: "windows-x64",
      transactionId: SECOND_ID,
    }),
    /candidate data format 1 cannot read installed format 2/,
  );
  assert.equal((await readCurrentRelease(paths))?.revision, NEW_REVISION);
});

test("activation atomically selects the complete release", async (t) => {
  const root = temporaryDirectory("cinba-activate-", t);
  const paths = layout(root);
  const source = await artifact(root, "source", "1.0.0", OLD_REVISION);
  await stageCandidate({
    sourceDirectory: source,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: FIRST_ID,
  });
  const transaction = await activateCandidate({ layout: paths });
  assert.equal(transaction.phase, "committed");
  assert.equal((await readCurrentRelease(paths))?.revision, OLD_REVISION);
  assert.equal(
    await readFile(join(paths.releasesDirectory, OLD_REVISION, "app.txt"), "utf8"),
    "1.0.0",
  );
});

test("failed verification restores the previous release", async (t) => {
  const root = temporaryDirectory("cinba-rollback-", t);
  const paths = layout(root);
  const oldSource = await artifact(root, "old", "1.0.0", OLD_REVISION);
  await stageCandidate({
    sourceDirectory: oldSource,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: FIRST_ID,
  });
  await activateCandidate({ layout: paths });

  const newSource = await artifact(root, "new", "2.0.0", NEW_REVISION);
  await stageCandidate({
    sourceDirectory: newSource,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: SECOND_ID,
  });
  await assert.rejects(
    activateCandidate({
      layout: paths,
      verify: async () => {
        throw new Error("health check failed");
      },
    }),
    /health check failed/,
  );
  assert.equal((await readCurrentRelease(paths))?.revision, OLD_REVISION);
  assert.equal((await readInstallationTransaction(paths))?.phase, "rolled-back");
  assert.equal(
    await readFile(join(paths.releasesDirectory, OLD_REVISION, "app.txt"), "utf8"),
    "1.0.0",
  );
});

test("failed data migration restores both the previous release and protected data", async (t) => {
  const root = temporaryDirectory("cinba-migration-rollback-", t);
  const paths = layout(root);
  const data = join(root, "data");
  await mkdir(data);
  await writeFile(join(data, "format.txt"), "format-1");
  const oldSource = await artifact(root, "old", "1.0.0", OLD_REVISION, "old", 1);
  await stageCandidate({
    sourceDirectory: oldSource,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: FIRST_ID,
  });
  await activateCandidate({ layout: paths });

  const newSource = await artifact(root, "new", "2.0.0", NEW_REVISION, "new", 2);
  await stageCandidate({
    sourceDirectory: newSource,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: SECOND_ID,
  });
  await assert.rejects(
    activateCandidate({
      layout: paths,
      dataMigration: {
        roots: [{ name: "data", path: data }],
        migrate: async () => {
          await writeFile(join(data, "format.txt"), "format-2-partial");
          throw new Error("migration failed");
        },
      },
    }),
    /migration failed/,
  );
  assert.equal((await readCurrentRelease(paths))?.revision, OLD_REVISION);
  assert.equal(await readFile(join(data, "format.txt"), "utf8"), "format-1");
  const transaction = await readInstallationTransaction(paths);
  assert.equal(transaction?.phase, "rolled-back");
  assert.equal(transaction?.failure, "data-migration-failed");
});

test("a data format upgrade requires an explicit protected migration", async (t) => {
  const root = temporaryDirectory("cinba-migration-required-", t);
  const paths = layout(root);
  const oldSource = await artifact(root, "old", "1.0.0", OLD_REVISION, "old", 1);
  await stageCandidate({
    sourceDirectory: oldSource,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: FIRST_ID,
  });
  await activateCandidate({ layout: paths });
  const newSource = await artifact(root, "new", "2.0.0", NEW_REVISION, "new", 2);
  await stageCandidate({
    sourceDirectory: newSource,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: SECOND_ID,
  });
  await assert.rejects(activateCandidate({ layout: paths }), /requires a protected data migration/);
  assert.equal((await readCurrentRelease(paths))?.revision, OLD_REVISION);
});

test("a protected data migration completes before release verification", async (t) => {
  const root = temporaryDirectory("cinba-migration-success-", t);
  const paths = layout(root);
  const data = join(root, "data");
  await mkdir(data);
  await writeFile(join(data, "format.txt"), "format-1");
  const oldSource = await artifact(root, "old", "1.0.0", OLD_REVISION, "old", 1);
  await stageCandidate({
    sourceDirectory: oldSource,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: FIRST_ID,
  });
  await activateCandidate({ layout: paths });
  const newSource = await artifact(root, "new", "2.0.0", NEW_REVISION, "new", 2);
  await stageCandidate({
    sourceDirectory: newSource,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: SECOND_ID,
  });

  const result = await activateCandidate({
    layout: paths,
    dataMigration: {
      roots: [{ name: "data", path: data }],
      migrate: async ({ fromDataFormatVersion, toDataFormatVersion }) => {
        assert.equal(fromDataFormatVersion, 1);
        assert.equal(toDataFormatVersion, 2);
        await writeFile(join(data, "format.txt"), "format-2");
      },
    },
    verify: async () => {
      assert.equal(await readFile(join(data, "format.txt"), "utf8"), "format-2");
    },
  });
  assert.equal(result.phase, "committed");
  assert.equal((await readCurrentRelease(paths))?.dataFormatVersion, 2);
});

test("recovery rolls back a migration interrupted after data changed", async (t) => {
  const root = temporaryDirectory("cinba-migration-recovery-", t);
  const paths = layout(root);
  const data = join(root, "data");
  const roots = [{ name: "data", path: data }];
  await mkdir(data);
  await writeFile(join(data, "format.txt"), "format-1");
  const oldSource = await artifact(root, "old", "1.0.0", OLD_REVISION, "old", 1);
  await stageCandidate({
    sourceDirectory: oldSource,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: FIRST_ID,
  });
  await activateCandidate({ layout: paths });
  const newSource = await artifact(root, "new", "2.0.0", NEW_REVISION, "new", 2);
  const ready = await stageCandidate({
    sourceDirectory: newSource,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: SECOND_ID,
  });
  await createDataSnapshot({ layout: paths, transactionId: SECOND_ID, roots });
  const target = { ...ready.candidate, directory: ready.candidate.revision };
  await rename(releasePath(paths, ready.candidate), releasePath(paths, target));
  await writeCurrentRelease(paths, target);
  await writeFile(join(data, "format.txt"), "format-2-partial");
  await writeInstallationTransaction(paths, { ...ready, phase: "migrating" });

  const recovered = await recoverInterruptedInstallation({
    layout: paths,
    dataMigration: { roots, migrate: async () => assert.fail("migration must not resume") },
  });
  assert.equal(recovered?.phase, "rolled-back");
  assert.equal((await readCurrentRelease(paths))?.revision, OLD_REVISION);
  assert.equal(await readFile(join(data, "format.txt"), "utf8"), "format-1");
});

test("same-version repair failure restores the exact installed directory", async (t) => {
  const root = temporaryDirectory("cinba-repair-", t);
  const paths = layout(root);
  const original = await artifact(root, "original", "1.0.0", OLD_REVISION, "original");
  await stageCandidate({
    sourceDirectory: original,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: FIRST_ID,
  });
  await activateCandidate({ layout: paths });

  const repair = await artifact(root, "repair", "1.0.0", OLD_REVISION, "replacement");
  await stageCandidate({
    sourceDirectory: repair,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: SECOND_ID,
  });
  await assert.rejects(
    activateCandidate({
      layout: paths,
      verify: async () => {
        throw new Error("repair verification failed");
      },
    }),
    /repair verification failed/,
  );
  assert.equal(
    await readFile(join(paths.releasesDirectory, OLD_REVISION, "app.txt"), "utf8"),
    "original",
  );
});

test("the installation lock refuses a competing transaction", async (t) => {
  const root = temporaryDirectory("cinba-install-lock-", t);
  const paths = layout(root);
  const unlock = await acquireInstallationLock(paths);
  await assert.rejects(acquireInstallationLock(paths), {
    message: "another Cinba installation transaction is active",
  });
  await unlock();
  const unlockAgain = await acquireInstallationLock(paths);
  await unlockAgain();
});

test("a lock left by a dead installer is recovered without deleting its successor", async (t) => {
  const root = temporaryDirectory("cinba-install-stale-lock-", t);
  const paths = layout(root);
  const staleUnlock = await acquireInstallationLock(paths, { processId: 2_147_483_647 });
  const activeUnlock = await acquireInstallationLock(paths);
  await staleUnlock();
  await assert.rejects(acquireInstallationLock(paths), {
    message: "another Cinba installation transaction is active",
  });
  await activeUnlock();
});

test("an installer waits for a running uninstall to release the lock", async (t) => {
  const root = temporaryDirectory("cinba-install-wait-", t);
  const paths = layout(root);
  const states: string[] = [];
  const unlock = await acquireInstallationLock(paths);
  const waiting = waitForInstallationIdle(paths, {
    timeoutMs: 5_000,
    pollMs: 10,
    onWait: (state) => void states.push(state),
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await unlock();
  await waiting;
  assert.deepEqual(states, ["waiting", "released"]);
});

test("an idle installation reports no waiting at all", async (t) => {
  const root = temporaryDirectory("cinba-install-no-wait-", t);
  const states: string[] = [];
  await waitForInstallationIdle(layout(root), {
    timeoutMs: 5_000,
    pollMs: 10,
    onWait: (state) => void states.push(state),
  });
  assert.deepEqual(states, []);
});

test("an installer refuses clearly when the lock stays held", async (t) => {
  const root = temporaryDirectory("cinba-install-wait-timeout-", t);
  const paths = layout(root);
  const unlock = await acquireInstallationLock(paths);
  await assert.rejects(waitForInstallationIdle(paths, { timeoutMs: 50, pollMs: 10 }), {
    message:
      "another Cinba installation or uninstall is still running; try again after it finishes",
  });
  await unlock();
});

test("recovery discards an interrupted staging directory", async (t) => {
  const root = temporaryDirectory("cinba-recover-staging-", t);
  const paths = layout(root);
  const source = await artifact(root, "source", "1.0.0", OLD_REVISION);
  const ready = await stageCandidate({
    sourceDirectory: source,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: FIRST_ID,
  });
  await writeInstallationTransaction(paths, { ...ready, phase: "staging" });
  const recovered = await recoverInterruptedInstallation({ layout: paths });
  assert.equal(recovered?.phase, "rolled-back");
  await assert.rejects(readFile(join(releasePath(paths, ready.candidate), "app.txt"), "utf8"), {
    code: "ENOENT",
  });
});

test("recovery resumes verification after the release pointer was switched", async (t) => {
  const root = temporaryDirectory("cinba-recover-verifying-", t);
  const paths = layout(root);
  const source = await artifact(root, "source", "1.0.0", OLD_REVISION);
  const ready = await stageCandidate({
    sourceDirectory: source,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: FIRST_ID,
  });
  const target = { ...ready.candidate, directory: ready.candidate.revision };
  await rename(releasePath(paths, ready.candidate), releasePath(paths, target));
  await writeCurrentRelease(paths, target);
  await writeInstallationTransaction(paths, { ...ready, phase: "verifying" });

  const recovered = await recoverInterruptedInstallation({ layout: paths });
  assert.equal(recovered?.phase, "committed");
  assert.deepEqual(await readCurrentRelease(paths), target);
});

test("failed recovery verification restores the previous release", async (t) => {
  const root = temporaryDirectory("cinba-recover-rollback-", t);
  const paths = layout(root);
  const oldSource = await artifact(root, "old", "1.0.0", OLD_REVISION);
  await stageCandidate({
    sourceDirectory: oldSource,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: FIRST_ID,
  });
  await activateCandidate({ layout: paths });
  const newSource = await artifact(root, "new", "2.0.0", NEW_REVISION);
  const ready = await stageCandidate({
    sourceDirectory: newSource,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: SECOND_ID,
  });
  const target = { ...ready.candidate, directory: ready.candidate.revision };
  await rename(releasePath(paths, ready.candidate), releasePath(paths, target));
  await writeCurrentRelease(paths, target);
  await writeInstallationTransaction(paths, { ...ready, phase: "verifying" });

  const recovered = await recoverInterruptedInstallation({
    layout: paths,
    verify: async () => {
      throw new Error("still unhealthy");
    },
  });
  assert.equal(recovered?.phase, "rolled-back");
  assert.equal((await readCurrentRelease(paths))?.revision, OLD_REVISION);
  await assert.rejects(readFile(join(paths.releasesDirectory, NEW_REVISION, "app.txt"), "utf8"), {
    code: "ENOENT",
  });
});

test("a disposable candidate moves into place instead of being copied", async (t) => {
  const root = temporaryDirectory("cinba-stage-move-", t);
  const paths = layout(root);
  const source = await artifact(root, "source", "1.0.0", OLD_REVISION);
  const transaction = await stageCandidate({
    sourceDirectory: source,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: FIRST_ID,
    consumeSource: true,
  });
  assert.equal(transaction.phase, "ready");
  assert.equal(
    await readFile(join(releasePath(paths, transaction.candidate), "app.txt"), "utf8"),
    "1.0.0",
  );
  await assert.rejects(readFile(join(source, "app.txt"), "utf8"), { code: "ENOENT" });
});

test("a candidate that is not disposable is left where the caller put it", async (t) => {
  const root = temporaryDirectory("cinba-stage-keep-", t);
  const paths = layout(root);
  const source = await artifact(root, "source", "1.0.0", OLD_REVISION);
  const transaction = await stageCandidate({
    sourceDirectory: source,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: FIRST_ID,
  });
  assert.equal(
    await readFile(join(releasePath(paths, transaction.candidate), "app.txt"), "utf8"),
    "1.0.0",
  );
  assert.equal(await readFile(join(source, "app.txt"), "utf8"), "1.0.0");
});

test("a disposable candidate on another volume falls back to a copy", async (t) => {
  const root = temporaryDirectory("cinba-stage-volume-", t);
  const paths = layout(root);
  const source = await artifact(root, "source", "1.0.0", OLD_REVISION);
  const transaction = await stageCandidate({
    sourceDirectory: source,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: FIRST_ID,
    consumeSource: true,
    rename: async () => {
      throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
    },
  });
  assert.equal(transaction.phase, "ready");
  assert.equal(
    await readFile(join(releasePath(paths, transaction.candidate), "app.txt"), "utf8"),
    "1.0.0",
  );
  assert.equal(await readFile(join(source, "app.txt"), "utf8"), "1.0.0");
});

test("a release directory locked for a moment is still switched", async (t) => {
  const root = temporaryDirectory("cinba-switch-retry-", t);
  const paths = layout(root);
  const source = await artifact(root, "source", "1.0.0", OLD_REVISION);
  await stageCandidate({
    sourceDirectory: source,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: FIRST_ID,
  });
  let attempts = 0;
  const delays: number[] = [];
  const transaction = await activateCandidate({
    layout: paths,
    rename: async (from, to) => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      }
      await rename(from, to);
    },
    delay: async (milliseconds) => void delays.push(milliseconds),
  });
  assert.equal(transaction.phase, "committed");
  assert.deepEqual(delays, [50, 100]);
  assert.equal(
    await readFile(join(paths.releasesDirectory, OLD_REVISION, "app.txt"), "utf8"),
    "1.0.0",
  );
});

test("a release directory that stays locked fails and keeps the installed release", async (t) => {
  const root = temporaryDirectory("cinba-switch-locked-", t);
  const paths = layout(root);
  const oldSource = await artifact(root, "old", "1.0.0", OLD_REVISION);
  await stageCandidate({
    sourceDirectory: oldSource,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: FIRST_ID,
  });
  await activateCandidate({ layout: paths });

  const newSource = await artifact(root, "new", "2.0.0", NEW_REVISION);
  await stageCandidate({
    sourceDirectory: newSource,
    layout: paths,
    expectedTarget: "windows-x64",
    transactionId: SECOND_ID,
  });
  const delays: number[] = [];
  await assert.rejects(
    activateCandidate({
      layout: paths,
      rename: async () => {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      },
      delay: async (milliseconds) => void delays.push(milliseconds),
    }),
    /operation not permitted/,
  );
  // A switch is retried with backoff for about five seconds before the transaction gives up.
  assert.deepEqual(delays.slice(0, 6), [50, 100, 200, 400, 800, 1_000]);
  const waited = delays.reduce((total, milliseconds) => total + milliseconds, 0);
  assert.ok(waited >= 5_000 && waited < 7_000, `waited ${waited}ms`);
  assert.equal((await readInstallationTransaction(paths))?.phase, "failed");
  assert.equal((await readCurrentRelease(paths))?.revision, OLD_REVISION);
  assert.equal(
    await readFile(join(paths.releasesDirectory, OLD_REVISION, "app.txt"), "utf8"),
    "1.0.0",
  );
});
