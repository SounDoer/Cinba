import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { temporaryDirectory } from "@cinba/test-support";
import { listDirectories } from "./directory-browser.ts";

test("a listing contains visible directories in alphabetical order", (t) => {
  const root = temporaryDirectory("cinba-dirs-", t);
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
