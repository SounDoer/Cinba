import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDeploymentStatus, writeDeploymentStatus } from "./status-file.ts";
import type { DeploymentStatus } from "./status.ts";

const TARGET = "abcdef1234567890abcdef1234567890abcdef12";
const UPDATED_AT = "2026-09-12T12:34:56.000Z";

function status(phase: DeploymentStatus["phase"]): DeploymentStatus {
  return {
    version: 1,
    phase,
    updatedAt: UPDATED_AT,
    ...(phase === "idle" ? {} : { targetRevision: TARGET }),
  };
}

test("a missing deployment status is distinct from a damaged one", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-deploy-status-"));
  const path = join(root, "nested", "deployment.json");
  try {
    assert.equal(await readDeploymentStatus(path), undefined);
    await writeFile(join(root, "broken.json"), "{token: secret", "utf8");
    await assert.rejects(
      readDeploymentStatus(join(root, "broken.json")),
      /Deployment status file is not valid JSON/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writing creates the parent and leaves one complete status file", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-deploy-status-"));
  const parent = join(root, "state");
  const path = join(parent, "deployment.json");
  try {
    await writeDeploymentStatus(path, status("preparing"));

    assert.deepEqual(await readDeploymentStatus(path), status("preparing"));
    assert.deepEqual(await readdir(parent), ["deployment.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a later write atomically replaces the previous complete status", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-deploy-status-"));
  const path = join(root, "deployment.json");
  try {
    await writeDeploymentStatus(path, status("preparing"));
    await writeDeploymentStatus(path, status("checking"));

    assert.deepEqual(await readDeploymentStatus(path), status("checking"));
    assert.deepEqual(await readdir(root), ["deployment.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalid replacement cannot damage the existing status", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-deploy-status-"));
  const path = join(root, "deployment.json");
  try {
    await writeDeploymentStatus(path, status("preparing"));
    await assert.rejects(
      writeDeploymentStatus(path, { ...status("checking"), targetRevision: "main" }),
      /Invalid deployment status/,
    );

    assert.deepEqual(await readDeploymentStatus(path), status("preparing"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
