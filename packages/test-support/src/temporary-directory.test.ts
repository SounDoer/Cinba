import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { removeTemporaryDirectory, temporaryDirectory } from "./temporary-directory.ts";

const linkType = process.platform === "win32" ? "junction" : "dir";

test("a temporary directory is created under the system temporary directory", (t) => {
  const root = temporaryDirectory("cinba-test-support-basic-", t);
  assert.equal(existsSync(root), true);
  assert.equal(root.startsWith(tmpdir()), true);
});

// The whole point of the helper: removal is handed to an `after` hook rather
// than run on the last line of the test body, so an assertion that throws
// halfway through no longer leaks the directory.
test("removal is registered as a hook, and that hook removes the directory", async () => {
  const hooks: Array<() => void | Promise<void>> = [];
  const root = temporaryDirectory("cinba-test-support-registry-", {
    after: (hook) => hooks.push(hook),
  });

  assert.equal(existsSync(root), true);
  assert.equal(hooks.length, 1);

  await hooks[0]?.();
  assert.equal(existsSync(root), false);
});

// The shape that left two permanently undeletable directories in %TEMP%. On
// Windows a junction whose target has been deleted cannot be removed by
// anything: readdir keeps listing it while every attempt to open it reports the
// file as missing, so its parent stays non-empty forever. A plain recursive
// remove deletes links and targets in whatever order it reaches them, which is
// why only a couple of runs out of hundreds got stuck. Removing every link in
// the tree first makes it impossible.
test("a tree holding a link to one of its own directories is removed completely", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-test-support-link-"));
  const target = join(root, "target");
  await mkdir(target);
  await writeFile(join(target, "file.txt"), "content");
  await symlink(target, join(root, "link"), linkType);

  await removeTemporaryDirectory(root);

  assert.equal(existsSync(root), false);
});

test("a link and its target in separate branches are removed completely", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-test-support-branches-"));
  const target = join(root, "first-branch", "target");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "file.txt"), "content");
  await mkdir(join(root, "second-branch"));
  await symlink(target, join(root, "second-branch", "link"), linkType);

  await removeTemporaryDirectory(root);

  assert.equal(existsSync(root), false);
});

// Links are unlinked, never followed: whatever a temporary directory points at
// from outside stays untouched.
test("a link is unlinked rather than followed into what it points at", async (t) => {
  const outside = temporaryDirectory("cinba-test-support-outside-", t);
  await writeFile(join(outside, "keep-me.txt"), "content");
  const root = await mkdtemp(join(tmpdir(), "cinba-test-support-follow-"));
  await symlink(outside, join(root, "link"), linkType);

  await removeTemporaryDirectory(root);

  assert.equal(existsSync(root), false);
  assert.equal(existsSync(join(outside, "keep-me.txt")), true);
});

test("removing an already-removed directory is not an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-test-support-twice-"));
  await removeTemporaryDirectory(root);
  await removeTemporaryDirectory(root);
  assert.equal(existsSync(root), false);
});

test("a deeply nested tree is removed despite long paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-test-support-deep-"));
  let current = root;
  for (let depth = 0; depth < 20; depth += 1) {
    current = join(current, "a-directory-name-long-enough-to-matter");
    await mkdir(current);
  }
  await writeFile(join(current, "leaf.txt"), "content");

  await removeTemporaryDirectory(root);

  assert.equal(existsSync(root), false);
});

test("nothing is left behind in the system temporary directory", async () => {
  const leftovers = (await readdir(tmpdir())).filter((entry) =>
    entry.startsWith("cinba-test-support-"),
  );
  assert.deepEqual(leftovers, []);
});
