import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { temporaryDirectory } from "@cinba/test-support";

test(
  "the TUI batch launcher passes a dragged project through the product CLI",
  { skip: process.platform !== "win32" },
  (t) => {
    const temporary = temporaryDirectory("cinba-cmd-", t);
    const fakeBin = join(temporary, "fake bin");
    const project = join(temporary, "dragged project");
    const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const launcher = join(repositoryRoot, "cinba-tui.cmd");
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
  },
);

test(
  "the Windows double-click launcher enters the Desktop product command",
  { skip: process.platform !== "win32" },
  (t) => {
    const temporary = temporaryDirectory("cinba-cmd-", t);
    const fakeBin = join(temporary, "fake bin");
    const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const launcher = join(repositoryRoot, "cinba-desktop.cmd");
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "node.cmd"), "@echo off\r\necho ARG1=[%~1]\r\necho ARG2=[%~2]\r\n");
    writeFileSync(join(temporary, "run.cmd"), `@echo off\r\ncall "${launcher}"\r\n`);

    const result = spawnSync("cmd.exe", ["/d", "/c", "run.cmd"], {
      cwd: temporary,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin};${process.env.PATH ?? ""}` },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ARG1=\[.*scripts\\cinba\.ts\]/i);
    assert.match(result.stdout, /ARG2=\[desktop\]/i);
    assert.doesNotMatch(result.stdout, /npm <command>/i);
  },
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
