import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchProdRevision, isFastForward } from "./git-source.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

test("prod is fetched and checked against the running history", async () => {
  const root = mkdtempSync(join(tmpdir(), "cinba-deploy-git-"));
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const monitor = join(root, "monitor");
  try {
    git(root, "init", "--bare", remote);
    git(root, "init", "--initial-branch=master", source);
    git(source, "config", "user.name", "Cinba Test");
    git(source, "config", "user.email", "cinba@example.invalid");
    writeFileSync(join(source, "version.txt"), "one\n");
    git(source, "add", "version.txt");
    git(source, "commit", "-m", "initial");
    const initial = git(source, "rev-parse", "HEAD");
    git(source, "remote", "add", "origin", remote);
    git(source, "push", "origin", "master", "master:prod");
    git(root, "clone", "--quiet", "--branch", "master", remote, monitor);

    assert.equal(await fetchProdRevision(monitor), initial);

    writeFileSync(join(source, "version.txt"), "two\n");
    git(source, "add", "version.txt");
    git(source, "commit", "-m", "second");
    const second = git(source, "rev-parse", "HEAD");
    git(source, "push", "origin", "HEAD:prod");

    assert.equal(await fetchProdRevision(monitor), second);
    assert.equal(await isFastForward(monitor, initial, second), true);
    assert.equal(await isFastForward(monitor, second, initial), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("revision arguments are validated before Git receives them", async () => {
  await assert.rejects(isFastForward(".", "HEAD", "0".repeat(40)), {
    message: "runningRevision is not a full Git revision",
  });
  await assert.rejects(isFastForward(".", "0".repeat(40), "origin/prod"), {
    message: "targetRevision is not a full Git revision",
  });
});
