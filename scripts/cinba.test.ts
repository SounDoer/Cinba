import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tuiProcessArguments } from "./cinba.ts";

test("the global cinba command enters the shared TUI launcher in the current directory", () => {
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const project = join(repositoryRoot, "example project");

  assert.deepEqual(tuiProcessArguments(project), [
    process.execPath,
    join(repositoryRoot, "scripts", "launch.ts"),
    "tui",
    resolve(project),
  ]);
});
