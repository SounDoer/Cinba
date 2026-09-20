import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectory } from "@cinba/test-support";
import { inspectProjectTrust, rememberProjectTrust } from "./project-trust.ts";

test("project agent skills require a trust decision", (t) => {
  const root = temporaryDirectory("cinba-project-trust-", t);
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

test("ordinary source directories do not require project trust", (t) => {
  const root = temporaryDirectory("cinba-project-trust-", t);
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  mkdirSync(join(project, "src"), { recursive: true });

  assert.deepEqual(inspectProjectTrust(project, agentDir), {
    required: false,
    decision: null,
    resources: [],
  });
});
