import assert from "node:assert/strict";
import test from "node:test";
import {
  type InstalledDoctorEvidence,
  diagnoseInstalledProduct,
  formatInstalledDoctorReport,
} from "./doctor.ts";

const revision = "a".repeat(40);
const evidence: InstalledDoctorEvidence = {
  release: {
    schemaVersion: 1,
    product: "Cinba",
    version: "1.2.3",
    revision,
    protocolVersion: 1,
    dataFormatVersion: 1,
    target: "windows-x64",
    nodeVersion: "24.1.0",
  },
  current: {
    version: "1.2.3",
    revision,
    protocolVersion: 1,
    dataFormatVersion: 1,
    target: "windows-x64",
    directory: revision,
  },
  expectedTarget: "windows-x64",
  runtimeVersion: "24.1.0",
  inventory: {
    schemaVersion: 1,
    product: "Cinba",
    version: "1.2.3",
    revision,
    target: "windows-x64",
    files: [{ path: "lib/cli.mjs", size: 1, sha256: "b".repeat(64), executable: false }],
  },
  inventoryVerification: { valid: true, problems: [] },
  core: {
    component: "core",
    state: "on-demand",
    desiredMode: "on-demand",
    phase: "stable",
    failure: null,
    registered: false,
    running: false,
    healthy: null,
  },
  sync: { component: "sync", state: "not-created" },
};

test("installed diagnosis verifies platform, private runtime, payload, activation, and services", () => {
  const report = diagnoseInstalledProduct(evidence);
  assert.equal(report.healthy, true);
  assert.deepEqual(
    report.diagnostics.map(({ level, label }) => ({ level, label })),
    [
      { level: "pass", label: "Platform" },
      { level: "pass", label: "Runtime" },
      { level: "pass", label: "Payload" },
      { level: "pass", label: "Activation" },
      { level: "pass", label: "Core" },
      { level: "info", label: "Sync" },
    ],
  );
  assert.match(formatInstalledDoctorReport(report), /Result: ready$/);
});

test("payload damage and a stopped Background service make diagnosis fail", () => {
  const report = diagnoseInstalledProduct({
    ...evidence,
    inventoryVerification: {
      valid: false,
      problems: [{ path: "lib/cli.mjs", reason: "sha256" }],
    },
    core: {
      component: "core",
      state: "background",
      desiredMode: "background",
      phase: "stable",
      failure: null,
      registered: true,
      running: false,
      healthy: null,
    },
  });
  assert.equal(report.healthy, false);
  assert.match(formatInstalledDoctorReport(report), /\[FAIL\] Payload/);
  assert.match(formatInstalledDoctorReport(report), /\[FAIL\] Core/);
  assert.match(formatInstalledDoctorReport(report), /Result: problems found$/);
});

test("an on-demand Core on a host without Background is informational, not a failure", () => {
  const unavailable = "this host does not run systemd (systemctl was not found)";
  const report = diagnoseInstalledProduct({
    ...evidence,
    core: {
      component: "core",
      state: "on-demand",
      desiredMode: "on-demand",
      phase: "stable",
      failure: null,
      registered: false,
      running: false,
      healthy: null,
      backgroundUnavailable: unavailable,
    },
  });
  assert.equal(report.healthy, true);
  assert.match(
    formatInstalledDoctorReport(report),
    /\[INFO\] Core: mode is on-demand; Background unavailable: this host does not run systemd/,
  );

  const configured = diagnoseInstalledProduct({
    ...evidence,
    core: {
      component: "core",
      state: "background",
      desiredMode: "background",
      phase: "stable",
      failure: null,
      registered: false,
      running: false,
      healthy: null,
      backgroundUnavailable: unavailable,
    },
  });
  assert.equal(configured.healthy, false);
  assert.match(
    formatInstalledDoctorReport(configured),
    /\[FAIL\] Core: Background is configured but unavailable/,
  );
});
