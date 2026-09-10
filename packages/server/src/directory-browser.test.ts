import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { listDirectories } from "./directory-browser.ts";

test("a listing contains visible directories in alphabetical order", () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-dirs-"));
  try {
    mkdirSync(join(root, "zebra"));
    mkdirSync(join(root, "alpha"));
    mkdirSync(join(root, ".hidden"));
    writeFileSync(join(root, "notes.txt"), "not a directory");

    assert.deepEqual(listDirectories(root), {
      type: "dir_listing",
      path: root,
      parent: dirname(root),
      dirs: ["alpha", "zebra"],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable or missing path becomes an empty listing", () => {
  const missing = join(tmpdir(), "cinba-path-that-does-not-exist");

  assert.deepEqual(listDirectories(missing), {
    type: "dir_listing",
    path: missing,
    parent: dirname(missing),
    dirs: [],
  });
});

test("a filesystem root has no parent", () => {
  const root = parse(tmpdir()).root;
  assert.equal(listDirectories(root).parent, null);
});
