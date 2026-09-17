import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDataSnapshot } from "./data-snapshot.ts";
import { createArtifactInventory } from "./inventory.ts";
import { acquireInstallationLock } from "./installation-lock.ts";
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

test("a verified candidate stages without changing the current release", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-stage-"));
  const paths = layout(root);
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a damaged candidate never changes current", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-stage-damaged-"));
  const paths = layout(root);
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an older release cannot replace data written in a newer format", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-data-downgrade-"));
  const paths = layout(root);
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("activation atomically selects the complete release", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-activate-"));
  const paths = layout(root);
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed verification restores the previous release", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-rollback-"));
  const paths = layout(root);
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed data migration restores both the previous release and protected data", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-migration-rollback-"));
  const paths = layout(root);
  const data = join(root, "data");
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a data format upgrade requires an explicit protected migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-migration-required-"));
  const paths = layout(root);
  try {
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
      activateCandidate({ layout: paths }),
      /requires a protected data migration/,
    );
    assert.equal((await readCurrentRelease(paths))?.revision, OLD_REVISION);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a protected data migration completes before release verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-migration-success-"));
  const paths = layout(root);
  const data = join(root, "data");
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery rolls back a migration interrupted after data changed", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-migration-recovery-"));
  const paths = layout(root);
  const data = join(root, "data");
  const roots = [{ name: "data", path: data }];
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same-version repair failure restores the exact installed directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-repair-"));
  const paths = layout(root);
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the installation lock refuses a competing transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-install-lock-"));
  const paths = layout(root);
  try {
    const unlock = await acquireInstallationLock(paths);
    await assert.rejects(acquireInstallationLock(paths), {
      message: "another Cinba installation transaction is active",
    });
    await unlock();
    const unlockAgain = await acquireInstallationLock(paths);
    await unlockAgain();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a lock left by a dead installer is recovered without deleting its successor", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-install-stale-lock-"));
  const paths = layout(root);
  try {
    const staleUnlock = await acquireInstallationLock(paths, { processId: 2_147_483_647 });
    const activeUnlock = await acquireInstallationLock(paths);
    await staleUnlock();
    await assert.rejects(acquireInstallationLock(paths), {
      message: "another Cinba installation transaction is active",
    });
    await activeUnlock();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery discards an interrupted staging directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-recover-staging-"));
  const paths = layout(root);
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery resumes verification after the release pointer was switched", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-recover-verifying-"));
  const paths = layout(root);
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed recovery verification restores the previous release", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-recover-rollback-"));
  const paths = layout(root);
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
