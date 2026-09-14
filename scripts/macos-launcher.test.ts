import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test(
  "the macOS double-click launcher enters the Desktop product command",
  { skip: process.platform !== "darwin" },
  () => {
    const temporary = mkdtempSync(join(tmpdir(), "cinba-command-"));
    const fakeNode = join(temporary, "node");
    const output = join(temporary, "arguments.txt");
    const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const launcher = join(repositoryRoot, "cinba-desktop.command");
    try {
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
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);
