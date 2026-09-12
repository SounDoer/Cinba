import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readCurrentReleaseRevision,
  removeCurrentRelease,
  switchCurrentRelease,
} from "./switch-release.ts";

const ROOT = "/home/cinba/releases";
const CURRENT_LINK = "/home/cinba/current";
const CURRENT = "1234567890abcdef1234567890abcdef12345678";
const TARGET = "abcdef1234567890abcdef1234567890abcdef12";
const TARGET_PATH = `${ROOT}/${TARGET}`;

function fakes(
  options: {
    currentKind?: "missing" | "directory" | "symlink" | "other";
    currentTarget?: string;
    temporaryKind?: "missing" | "directory" | "symlink" | "other";
    targetKind?: "missing" | "directory" | "symlink" | "other";
    moveFails?: boolean;
  } = {},
) {
  const links: Array<{ target: string; path: string }> = [];
  const moves: Array<{ from: string; to: string }> = [];
  const removed: string[] = [];
  return {
    links,
    moves,
    removed,
    dependencies: {
      async pathKind(path: string) {
        if (path === TARGET_PATH) {
          return options.targetKind ?? "directory";
        }
        if (path === CURRENT_LINK) {
          return options.currentKind ?? "symlink";
        }
        return options.temporaryKind ?? "missing";
      },
      async readLink() {
        return options.currentTarget ?? `releases/${CURRENT}`;
      },
      async createLink(target: string, path: string) {
        links.push({ target, path });
      },
      async move(from: string, to: string) {
        moves.push({ from, to });
        if (options.moveFails) {
          throw new Error("rename failed");
        }
      },
      async removeLink(path: string) {
        removed.push(path);
      },
    },
  };
}

test("current is atomically replaced only when it names the expected old release", async () => {
  const fake = fakes();
  await switchCurrentRelease(
    {
      releasesRoot: ROOT,
      currentLink: CURRENT_LINK,
      targetRevision: TARGET.toUpperCase(),
      expectedCurrentRevision: CURRENT,
    },
    fake.dependencies,
  );

  assert.deepEqual(fake.links, [{ target: `releases/${TARGET}`, path: `${CURRENT_LINK}.next` }]);
  assert.deepEqual(fake.moves, [{ from: `${CURRENT_LINK}.next`, to: CURRENT_LINK }]);
  assert.deepEqual(fake.removed, []);
});

test("the first deployment may create current when no previous release exists", async () => {
  const fake = fakes({ currentKind: "missing" });
  await switchCurrentRelease(
    { releasesRoot: ROOT, currentLink: CURRENT_LINK, targetRevision: TARGET },
    fake.dependencies,
  );
  assert.equal(fake.moves.length, 1);
});

test("a stale or malformed current pointer stops the switch", async () => {
  const stale = fakes({ currentTarget: `releases/${TARGET}` });
  await assert.rejects(
    switchCurrentRelease(
      {
        releasesRoot: ROOT,
        currentLink: CURRENT_LINK,
        targetRevision: TARGET,
        expectedCurrentRevision: CURRENT,
      },
      stale.dependencies,
    ),
    /does not match/,
  );
  assert.deepEqual(stale.links, []);

  const regularDirectory = fakes({ currentKind: "directory" });
  await assert.rejects(
    switchCurrentRelease(
      {
        releasesRoot: ROOT,
        currentLink: CURRENT_LINK,
        targetRevision: TARGET,
        expectedCurrentRevision: CURRENT,
      },
      regularDirectory.dependencies,
    ),
    /not a symbolic link/,
  );
});

test("an unprepared target or occupied temporary link stops the switch", async () => {
  const unprepared = fakes({ targetKind: "missing" });
  await assert.rejects(
    switchCurrentRelease(
      {
        releasesRoot: ROOT,
        currentLink: CURRENT_LINK,
        targetRevision: TARGET,
        expectedCurrentRevision: CURRENT,
      },
      unprepared.dependencies,
    ),
    /not a prepared directory/,
  );

  const occupied = fakes({ temporaryKind: "symlink" });
  await assert.rejects(
    switchCurrentRelease(
      {
        releasesRoot: ROOT,
        currentLink: CURRENT_LINK,
        targetRevision: TARGET,
        expectedCurrentRevision: CURRENT,
      },
      occupied.dependencies,
    ),
    /already exists/,
  );
  assert.deepEqual(occupied.links, []);
});

test("a failed atomic rename removes only the temporary link", async () => {
  const fake = fakes({ moveFails: true });
  await assert.rejects(
    switchCurrentRelease(
      {
        releasesRoot: ROOT,
        currentLink: CURRENT_LINK,
        targetRevision: TARGET,
        expectedCurrentRevision: CURRENT,
      },
      fake.dependencies,
    ),
    /rename failed/,
  );
  assert.deepEqual(fake.removed, [`${CURRENT_LINK}.next`]);
});

test("a failed first deployment removes current only when it still names that target", async () => {
  const matching = fakes({ currentTarget: `releases/${TARGET}` });
  await removeCurrentRelease(
    { releasesRoot: ROOT, currentLink: CURRENT_LINK, expectedCurrentRevision: TARGET },
    matching.dependencies,
  );
  assert.deepEqual(matching.removed, [CURRENT_LINK]);

  const changed = fakes({ currentTarget: `releases/${CURRENT}` });
  await assert.rejects(
    removeCurrentRelease(
      { releasesRoot: ROOT, currentLink: CURRENT_LINK, expectedCurrentRevision: TARGET },
      changed.dependencies,
    ),
    /does not match/,
  );
  assert.deepEqual(changed.removed, []);
});

test("current can be inspected without following an unsafe filesystem entry", async () => {
  const linked = fakes();
  assert.equal(
    await readCurrentReleaseRevision(
      { releasesRoot: ROOT, currentLink: CURRENT_LINK },
      linked.dependencies,
    ),
    CURRENT,
  );

  const missing = fakes({ currentKind: "missing" });
  assert.equal(
    await readCurrentReleaseRevision(
      { releasesRoot: ROOT, currentLink: CURRENT_LINK },
      missing.dependencies,
    ),
    undefined,
  );

  const directory = fakes({ currentKind: "directory" });
  await assert.rejects(
    readCurrentReleaseRevision(
      { releasesRoot: ROOT, currentLink: CURRENT_LINK },
      directory.dependencies,
    ),
    /not a symbolic link/,
  );
});
