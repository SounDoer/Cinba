import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectProjectTrust, rememberProjectTrust } from "./project-trust.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "cinba-project-trust-"));
  temporaryDirectories.push(directory);
  return directory;
}

test("project agent skills require a trust decision", () => {
  const root = temporaryDirectory();
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  mkdirSync(join(project, ".agents", "skills", "review"), { recursive: true });

  assert.deepEqual(inspectProjectTrust(project, agentDir), {
    required: true,
    decision: null,
    resources: [".agents/skills"],
  });

  rememberProjectTrust(project, true, agentDir);
  assert.equal(inspectProjectTrust(project, agentDir).decision, true);
});

test("ordinary source directories do not require project trust", () => {
  const root = temporaryDirectory();
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  mkdirSync(join(project, "src"), { recursive: true });

  assert.deepEqual(inspectProjectTrust(project, agentDir), {
    required: false,
    decision: null,
    resources: [],
  });
});
