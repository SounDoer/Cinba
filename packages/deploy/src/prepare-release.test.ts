import { test } from "node:test";
import assert from "node:assert/strict";
import { ReleasePreparationError, prepareRelease } from "./prepare-release.ts";

const REPO = "/home/cinba/Cinba";
const ROOT = "/home/cinba/releases";
const TARGET = "abcdef1234567890abcdef1234567890abcdef12";
const PATH = `${ROOT}/${TARGET}`;

type Call = { command: string; args: string[]; cwd: string };

function fakes(options: { exists?: boolean; failAt?: number; failCleanup?: boolean } = {}) {
  const calls: Call[] = [];
  const made: string[] = [];
  const removed: string[] = [];
  let preparationCall = 0;

  return {
    calls,
    made,
    removed,
    dependencies: {
      async pathExists() {
        return options.exists ?? false;
      },
      async makeDirectory(path: string) {
        made.push(path);
      },
      async removeDirectory(path: string) {
        removed.push(path);
        if (options.failCleanup) {
          throw new Error("cleanup failed");
        }
      },
      async runCommand(command: string, args: string[], cwd: string) {
        calls.push({ command, args, cwd });
        if (args[0] !== "worktree" || args[1] === "add") {
          preparationCall += 1;
          if (preparationCall === options.failAt) {
            throw new Error("preparation failed");
          }
        }
      },
    },
  };
}

test("a release is checked out, installed, and checked beside the running version", async () => {
  const fake = fakes();
  assert.deepEqual(
    await prepareRelease(
      { repoPath: REPO, releasesRoot: ROOT, targetRevision: TARGET.toUpperCase() },
      fake.dependencies,
    ),
    { path: PATH, revision: TARGET },
  );
  assert.deepEqual(fake.made, [ROOT]);
  assert.deepEqual(fake.removed, []);
  assert.deepEqual(fake.calls, [
    {
      command: "git",
      args: ["worktree", "add", "--detach", PATH, TARGET],
      cwd: REPO,
    },
    { command: "npm", args: ["ci"], cwd: PATH },
    { command: "npm", args: ["run", "check"], cwd: PATH },
  ]);
});

test("an existing release is preserved and stops preparation", async () => {
  const fake = fakes({ exists: true });
  await assert.rejects(
    prepareRelease(
      { repoPath: REPO, releasesRoot: ROOT, targetRevision: TARGET },
      fake.dependencies,
    ),
    { message: "Target release directory already exists" },
  );
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(fake.removed, []);
});

test("a failed install removes only the release created by this attempt", async () => {
  const fake = fakes({ failAt: 2 });
  await assert.rejects(
    prepareRelease(
      { repoPath: REPO, releasesRoot: ROOT, targetRevision: TARGET },
      fake.dependencies,
    ),
    (error: unknown) => {
      assert.equal(error instanceof ReleasePreparationError, true);
      assert.equal((error as ReleasePreparationError).failure, "install");
      return true;
    },
  );
  assert.deepEqual(fake.calls.at(-1), {
    command: "git",
    args: ["worktree", "remove", "--force", PATH],
    cwd: REPO,
  });
  assert.deepEqual(fake.removed, [PATH]);
});

test("checking is announced after installation and failures keep their stage", async () => {
  const fake = fakes({ failAt: 3 });
  await assert.rejects(
    prepareRelease(
      {
        repoPath: REPO,
        releasesRoot: ROOT,
        targetRevision: TARGET,
        async onChecking() {
          fake.calls.push({ command: "status", args: ["checking"], cwd: PATH });
        },
      },
      fake.dependencies,
    ),
    (error: unknown) => {
      assert.equal((error as ReleasePreparationError).failure, "checks");
      return true;
    },
  );
  assert.deepEqual(fake.calls.slice(1, 4), [
    { command: "npm", args: ["ci"], cwd: PATH },
    { command: "status", args: ["checking"], cwd: PATH },
    { command: "npm", args: ["run", "check"], cwd: PATH },
  ]);
});

test("a cleanup failure is reported together with the preparation failure", async () => {
  const fake = fakes({ failAt: 3, failCleanup: true });
  await assert.rejects(
    prepareRelease(
      { repoPath: REPO, releasesRoot: ROOT, targetRevision: TARGET },
      fake.dependencies,
    ),
    (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(
        (error as AggregateError).message,
        "Release preparation failed and its directory could not be cleaned",
      );
      assert.equal((error as AggregateError).errors.length, 2);
      return true;
    },
  );
});
