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

test("asks before direct access to sensitive files", () => {
  const cases = [
    { ...POSIX, toolName: "read", input: { path: ".env.production" } },
    { ...POSIX, toolName: "grep", input: { pattern: "token", path: "~/.ssh" } },
    { ...WINDOWS, toolName: "edit", input: { path: "$env:USERPROFILE\\.aws\\credentials" } },
    { ...WINDOWS, toolName: "write", input: { path: ".npmrc" } },
  ];

  for (const context of cases) {
    const decision = evaluatePermission(context);
    assert.equal(decision.effect, "ask", JSON.stringify(context.input));
    assert.equal(decision.ruleId, "path.sensitive");
  }
});

test("asks before writing outside the workspace", () => {
  const decision = evaluatePermission({
    ...WINDOWS,
    toolName: "write",
    input: { path: "C:\\Users\\alice\\Desktop\\note.txt", content: "hello" },
  });

  assert.equal(decision.effect, "ask");
  assert.equal(decision.ruleId, "path.write-outside-workspace");
});

test("asks for deletion, overwrite, destructive Git, elevation, and permission changes", () => {
  const cases = [
    command(POSIX, "rm ./old.txt"),
    command(WINDOWS, "Remove-Item .\\dist -Recurse"),
    command(POSIX, "echo rebuilt > output.txt"),
    command(WINDOWS, "Set-Content .\\config.json updated"),
    command(POSIX, "git reset --hard"),
    command(POSIX, "git clean -fd"),
    command(POSIX, "git restore src/app.ts"),
    command(POSIX, "git push --force-with-lease"),
    command(POSIX, "sudo npm test"),
    command(WINDOWS, "icacls .\\cache /reset"),
  ];

  for (const context of cases) {
    assert.equal(evaluatePermission(context).effect, "ask", JSON.stringify(context.input));
  }
});

test("asks when common shell commands access a sensitive path", () => {
  const cases = [command(POSIX, "cat .env"), command(WINDOWS, "Get-Content .npmrc")];
  for (const context of cases) {
    const decision = evaluatePermission(context);
    assert.equal(decision.effect, "ask");
    assert.equal(decision.ruleId, "shell.sensitive-path");
  }
});

test("asks before an unknown extension tool runs", () => {
  const decision = evaluatePermission({ ...POSIX, toolName: "deploy", input: { target: "prod" } });
  assert.equal(decision.effect, "ask");
  assert.equal(decision.ruleId, "tool.unknown");
});

test("allows ordinary built-in operations by default", () => {
  assert.equal(
    evaluatePermission({ ...WINDOWS, toolName: "read", input: { path: "README.md" } }).effect,
    "allow",
  );
  assert.equal(
    evaluatePermission({ ...WINDOWS, toolName: "edit", input: { path: "src/app.ts" } }).effect,
    "allow",
  );
  assert.equal(evaluatePermission(command(WINDOWS, "npm test")).effect, "allow");
  assert.equal(evaluatePermission(command(POSIX, "git status && npm test")).effect, "allow");
});

test("does not mistake quoted redirection or help output for a risky operation", () => {
  assert.equal(evaluatePermission(command(POSIX, 'echo "a > b"')).effect, "allow");
  assert.equal(
    evaluatePermission(command(POSIX, "cat package.json 2>/dev/null | head -50")).effect,
    "allow",
  );
  assert.equal(evaluatePermission(command(POSIX, "npm test >/dev/null 2>&1")).effect, "allow");
  assert.equal(evaluatePermission(command(WINDOWS, "npm test *> $null")).effect, "allow");
  assert.equal(evaluatePermission(command(WINDOWS, "npm test 2>NUL")).effect, "allow");
  assert.equal(evaluatePermission(command(POSIX, "rm --help")).effect, "allow");
});
