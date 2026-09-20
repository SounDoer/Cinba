import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import {
  createDataSnapshot,
  dataSnapshotPath,
  discardDataSnapshot,
  restoreDataSnapshot,
} from "./data-snapshot.ts";
import type { InstallationLayout } from "./installation-store.ts";

const TRANSACTION_ID = "11111111-1111-4111-8111-111111111111";

function layout(root: string): InstallationLayout {
  return {
    programDirectory: join(root, "program"),
    releasesDirectory: join(root, "program", "releases"),
    transactionDirectory: join(root, "state", "install"),
  };
}

test("a protected snapshot records existing and absent data roots", async (t) => {
  const root = temporaryDirectory("cinba-data-snapshot-", t);
  const paths = layout(root);
  const data = join(root, "data");
  const config = join(root, "config");
  await mkdir(data);
  await writeFile(join(data, "session.json"), "before");
  const snapshot = await createDataSnapshot({
    layout: paths,
    transactionId: TRANSACTION_ID,
    roots: [
      { name: "data", path: data },
      { name: "config", path: config },
    ],
    now: () => new Date("2026-09-17T00:00:00.000Z"),
  });
  assert.deepEqual(snapshot.roots, [
    { name: "data", existed: true },
    { name: "config", existed: false },
  ]);
  assert.equal(
    await readFile(join(dataSnapshotPath(paths, TRANSACTION_ID), "data", "session.json"), "utf8"),
    "before",
  );
});

test("restoring a snapshot replaces changed data and removes newly created roots", async (t) => {
  const root = temporaryDirectory("cinba-data-restore-", t);
  const paths = layout(root);
  const data = join(root, "data");
  const config = join(root, "config");
  const roots = [
    { name: "data", path: data },
    { name: "config", path: config },
  ];
  await mkdir(data);
  await writeFile(join(data, "session.json"), "before");
  await createDataSnapshot({ layout: paths, transactionId: TRANSACTION_ID, roots });
  await writeFile(join(data, "session.json"), "after");
  await mkdir(config);
  await writeFile(join(config, "settings.json"), "new");

  await restoreDataSnapshot({ layout: paths, transactionId: TRANSACTION_ID, roots });
  assert.equal(await readFile(join(data, "session.json"), "utf8"), "before");
  await assert.rejects(readFile(join(config, "settings.json"), "utf8"), { code: "ENOENT" });
  await discardDataSnapshot(paths, TRANSACTION_ID);
  await assert.rejects(readFile(join(dataSnapshotPath(paths, TRANSACTION_ID), "snapshot.json")), {
    code: "ENOENT",
  });
});

test("snapshot roots cannot overlap installer storage or each other", async (t) => {
  const root = temporaryDirectory("cinba-data-boundary-", t);
  const paths = layout(root);
  await assert.rejects(
    createDataSnapshot({
      layout: paths,
      transactionId: TRANSACTION_ID,
      roots: [{ name: "bad", path: join(paths.transactionDirectory, "nested") }],
    }),
    /overlaps installer-owned storage/,
  );
  await assert.rejects(
    createDataSnapshot({
      layout: paths,
      transactionId: TRANSACTION_ID,
      roots: [
        { name: "data", path: join(root, "data") },
        { name: "nested", path: join(root, "data", "nested") },
      ],
    }),
    /must not overlap each other/,
  );
});
