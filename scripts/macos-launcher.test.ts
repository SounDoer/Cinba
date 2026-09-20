import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { temporaryDirectory } from "@cinba/test-support";

test(
  "the macOS double-click launcher enters the Desktop product command",
  { skip: process.platform !== "darwin" },
  (t) => {
    const temporary = temporaryDirectory("cinba-command-", t);
    const fakeNode = join(temporary, "node");
    const output = join(temporary, "arguments.txt");
    const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const launcher = join(repositoryRoot, "cinba-desktop.command");
    writeFileSync(
      fakeNode,
      `#!/bin/sh\nif [ "$1" = "-p" ]; then echo 24; exit 0; fi\nprintf '%s\\n' "$@" > "$CINBA_TEST_OUTPUT"\n`,
    );
    chmodSync(fakeNode, 0o755);

    const result = spawnSync(launcher, [], {
      cwd: temporary,
      encoding: "utf8",
      env: { ...process.env, CINBA_NODE: fakeNode, CINBA_TEST_OUTPUT: output },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(output, "utf8").trim().split("\n"), [
      join(repositoryRoot, "scripts", "cinba.ts"),
      "desktop",
    ]);
  },
);
