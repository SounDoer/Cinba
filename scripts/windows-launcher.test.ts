import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test(
  "the TUI batch launcher passes a dragged project through the product CLI",
  { skip: process.platform !== "win32" },
  () => {
    const temporary = mkdtempSync(join(tmpdir(), "cinba-cmd-"));
    const fakeBin = join(temporary, "fake bin");
    const project = join(temporary, "dragged project");
    const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const launcher = join(repositoryRoot, "cinba-tui.cmd");
    try {
      mkdirSync(fakeBin);
      mkdirSync(project);
      writeFileSync(
        join(fakeBin, "node.cmd"),
        "@echo off\r\necho ARG1=[%~1]\r\necho ARG2=[%~2]\r\necho ARG3=[%~3]\r\n",
      );
      writeFileSync(join(temporary, "run.cmd"), `@echo off\r\ncall "${launcher}" "${project}"\r\n`);

      const result = spawnSync("cmd.exe", ["/d", "/c", "run.cmd"], {
        cwd: temporary,
        encoding: "utf8",
        env: { ...process.env, PATH: `${fakeBin};${process.env.PATH ?? ""}` },
      });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ARG1=\[.*scripts\\cinba\.ts\]/i);
      assert.match(result.stdout, /ARG2=\[tui\]/i);
      assert.match(result.stdout, new RegExp(`ARG3=\\[${escapeRegExp(project)}\\]`, "i"));
      assert.doesNotMatch(result.stdout, /npm <command>/i);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
