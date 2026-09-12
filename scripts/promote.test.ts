import { test } from "node:test";
import assert from "node:assert/strict";
import { promote } from "./promote.ts";

const REVISION = "abcdef1234567890abcdef1234567890abcdef12";
const NPM_CLI = "/tools/npm-cli.js";

type Response = { stdout?: string; error?: Error };

function runner(responses: Response[]) {
  const calls: Array<{ command: string; args: string[]; showOutput: boolean }> = [];
  return {
    calls,
    async run(command: string, args: string[], options: { showOutput?: boolean } = {}) {
      calls.push({ command, args, showOutput: options.showOutput ?? false });
      const response = responses.shift() ?? {};
      if (response.error) {
        throw response.error;
      }
      return { stdout: response.stdout ?? "" };
    },
  };
}

function successfulResponses(): Response[] {
  return [
    { stdout: "master\n" },
    { stdout: "" },
    {},
    { stdout: `${REVISION}\n` },
    { stdout: `${REVISION}\n` },
    {},
    { stdout: "" },
    { stdout: `${REVISION}\n` },
    {},
  ];
}

test("promotion checks the exact pushed master before advancing prod", async () => {
  const fake = runner(successfulResponses());
  assert.equal(await promote(fake.run, NPM_CLI), REVISION);
  assert.deepEqual(fake.calls, [
    { command: "git", args: ["symbolic-ref", "--short", "HEAD"], showOutput: false },
    { command: "git", args: ["status", "--porcelain"], showOutput: false },
    { command: "git", args: ["fetch", "--quiet", "origin", "master"], showOutput: false },
    { command: "git", args: ["rev-parse", "HEAD"], showOutput: false },
    {
      command: "git",
      args: ["rev-parse", "refs/remotes/origin/master"],
      showOutput: false,
    },
    { command: process.execPath, args: [NPM_CLI, "run", "check"], showOutput: true },
    { command: "git", args: ["status", "--porcelain"], showOutput: false },
    { command: "git", args: ["rev-parse", "HEAD"], showOutput: false },
    {
      command: "git",
      args: ["push", "origin", "HEAD:refs/heads/prod"],
      showOutput: false,
    },
  ]);
});

test("a branch, working tree, or remote mismatch stops before checks and push", async () => {
  const wrongBranch = runner([{ stdout: "feature\n" }]);
  await assert.rejects(promote(wrongBranch.run, NPM_CLI), /master branch/);

  const dirty = runner([{ stdout: "master\n" }, { stdout: " M file.ts\n" }]);
  await assert.rejects(promote(dirty.run, NPM_CLI), /clean working tree/);

  const behind = runner([
    { stdout: "master\n" },
    { stdout: "" },
    {},
    { stdout: `${REVISION}\n` },
    { stdout: `${"1".repeat(40)}\n` },
  ]);
  await assert.rejects(promote(behind.run, NPM_CLI), /exactly match/);
  assert.equal(
    behind.calls.some((call) => call.args.includes("check")),
    false,
  );
  assert.equal(
    behind.calls.some((call) => call.args[0] === "push"),
    false,
  );
});

test("checks that dirty the tree or move HEAD prevent the push", async () => {
  const dirtyAfter = successfulResponses();
  dirtyAfter[6] = { stdout: " M generated.ts\n" };
  const dirty = runner(dirtyAfter);
  await assert.rejects(promote(dirty.run, NPM_CLI), /changed the working tree/);
  assert.equal(
    dirty.calls.some((call) => call.args[0] === "push"),
    false,
  );

  const movedAfter = successfulResponses();
  movedAfter[7] = { stdout: `${"1".repeat(40)}\n` };
  const moved = runner(movedAfter);
  await assert.rejects(promote(moved.run, NPM_CLI), /HEAD changed/);
  assert.equal(
    moved.calls.some((call) => call.args[0] === "push"),
    false,
  );
});
