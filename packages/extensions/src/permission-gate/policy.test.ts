import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePermission } from "./policy.ts";
import type { PermissionContext } from "./types.ts";

const WINDOWS: PermissionContext = {
  toolName: "powershell",
  input: {},
  cwd: "C:\\Users\\alice\\code\\cinba",
  homeDir: "C:\\Users\\alice",
  platform: "win32",
  systemRoot: "C:\\Windows",
};

const POSIX: PermissionContext = {
  toolName: "bash",
  input: {},
  cwd: "/home/alice/code/cinba",
  homeDir: "/home/alice",
  platform: "linux",
};

function command(base: PermissionContext, value: string): PermissionContext {
  return { ...base, input: { command: value } };
}

test("blocks recursive deletion of filesystem, home, system, and workspace roots", () => {
  const cases = [
    command(POSIX, "rm -rf /"),
    command(POSIX, 'rm --recursive "$HOME"'),
    command(POSIX, 'rm --recursive "${HOME}/"'),
    command(POSIX, "rm -r /etc"),
    command(POSIX, "rm -rf ."),
    command(WINDOWS, "Remove-Item -Recurse -Force C:\\"),
    command(WINDOWS, "Remove-Item -Recurse $env:USERPROFILE"),
    command(WINDOWS, "ri -Recurse %USERPROFILE%\\"),
    command(WINDOWS, "Remove-Item C:\\Windows -Recurse"),
    command(WINDOWS, "rd /s /q C:\\Users\\alice\\code\\cinba"),
  ];

  for (const context of cases) {
    const decision = evaluatePermission(context);
    assert.equal(decision.effect, "block", JSON.stringify(context.input));
    assert.equal(decision.ruleId, "shell.delete-protected-root");
  }
});

test("does not confuse ordinary deletion or quoted examples with root deletion", () => {
  const cases = [
    command(POSIX, "rm -rf ./dist"),
    command(POSIX, 'echo "rm -rf /"'),
    command(WINDOWS, "Remove-Item .\\tmp.txt"),
    command(WINDOWS, "Remove-Item -Recurse .\\dist"),
    command(WINDOWS, 'Write-Output "Remove-Item -Recurse C:\\"'),
  ];

  for (const context of cases) {
    assert.notEqual(evaluatePermission(context).effect, "block", JSON.stringify(context.input));
  }
});

test("blocks commands whose purpose is destroying a disk", () => {
  const cases = [
    command(WINDOWS, "Format-Volume -DriveLetter D"),
    command(WINDOWS, "format.com D: /Q"),
    command(WINDOWS, "Clear-Disk -Number 1 -RemoveData"),
    command(POSIX, "sudo mkfs.ext4 /dev/sdb1"),
    command(POSIX, "/usr/sbin/mkfs /dev/sdb1"),
    command(POSIX, "wipefs --all /dev/sdb"),
  ];

  for (const context of cases) {
    const decision = evaluatePermission(context);
    assert.equal(decision.effect, "block", JSON.stringify(context.input));
    assert.equal(decision.ruleId, "shell.destroy-disk");
  }
});

test("allows inspection modes of otherwise destructive disk commands", () => {
  const cases = [
    command(WINDOWS, "format /?"),
    command(WINDOWS, "Clear-Disk -Number 1 -WhatIf"),
    command(POSIX, "mkfs.ext4 --help"),
    command(POSIX, "wipefs --version"),
  ];

  for (const context of cases) {
    assert.notEqual(evaluatePermission(context).effect, "block", JSON.stringify(context.input));
  }
});

test("blocks recursive permission changes on protected roots only", () => {
  const blocked = [
    command(POSIX, "chmod -R 777 /"),
    command(POSIX, "sudo chown --recursive alice /home/alice"),
    command(WINDOWS, "icacls C:\\Windows /reset /t"),
    command(WINDOWS, "takeown /f C:\\ /r"),
  ];
  const ordinary = [
    command(POSIX, "chmod 755 ./scripts/start.sh"),
    command(POSIX, "chmod -R 755 ./dist"),
    command(WINDOWS, "icacls .\\cache /reset /t"),
  ];

  for (const context of blocked) {
    assert.equal(evaluatePermission(context).effect, "block", JSON.stringify(context.input));
  }
  for (const context of ordinary) {
    assert.notEqual(evaluatePermission(context).effect, "block", JSON.stringify(context.input));
  }
});

test("keeps the existing allow and ask defaults during the block-rule phase", () => {
  assert.equal(
    evaluatePermission({ ...WINDOWS, toolName: "read", input: { path: "README.md" } }).effect,
    "allow",
  );
  assert.equal(evaluatePermission(command(WINDOWS, "npm test")).effect, "ask");
});
