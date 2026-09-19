import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { diagnoseNode, formatDoctorReport, remoteHealthBaseUrl, runDoctor } from "./doctor.ts";

test("Node diagnosis enforces the supported major version", () => {
  assert.equal(diagnoseNode("v24.1.0").level, "pass");
  assert.equal(diagnoseNode("v23.9.0").level, "fail");
  assert.equal(diagnoseNode("unknown").level, "fail");
});

test("remote Core URLs are converted to their matching health origin", () => {
  assert.equal(remoteHealthBaseUrl("ws://example.test:4517/ws"), "http://example.test:4517/ws");
  assert.equal(remoteHealthBaseUrl("wss://example.test/ws"), "https://example.test/ws");
  assert.equal(remoteHealthBaseUrl("file:///tmp/core"), undefined);
  assert.equal(remoteHealthBaseUrl("not a URL"), undefined);
});

test("a stopped local Core is informational because clients start it on demand", async () => {
  const report = await runDoctor({
    projectDirectory: "project",
    nodeVersion: "v24.1.0",
    repositoryRoot: "repository",
    pathKind: (path) => (path === resolve("project") ? "directory" : "file"),
    inspectCore: async () => ({ state: "stopped", running: false, managed: false }),
  });

  assert.equal(report.healthy, true);
  assert.deepEqual(
    report.diagnostics.map(({ level, label }) => ({ level, label })),
    [
      { level: "pass", label: "Runtime" },
      { level: "pass", label: "Checkout" },
      { level: "pass", label: "Project" },
      { level: "info", label: "Core" },
    ],
  );
  assert.match(formatDoctorReport(report), /Result: ready$/);
});

test("without CINBA_SERVER the Dev Core is inspected, never the installed Cinba Core", async () => {
  const requested: string[] = [];
  const report = await runDoctor({
    projectDirectory: "project",
    nodeVersion: "v24.1.0",
    repositoryRoot: "repository",
    pathKind: (path) => (path === resolve("project") ? "directory" : "file"),
    probeCore: async (baseUrl) => {
      requested.push(baseUrl);
      return undefined;
    },
  });

  assert.deepEqual(requested, ["http://127.0.0.1:4527/"]);
  assert.equal(report.diagnostics.at(-1)?.level, "info");
});

test("an invalid project and unreachable configured Core make diagnosis fail", async () => {
  const requested: string[] = [];
  const report = await runDoctor({
    projectDirectory: "missing",
    nodeVersion: "v24.1.0",
    repositoryRoot: "repository",
    serverUrl: "ws://example.test:4517/ws",
    pathKind: (path) => (path === resolve("missing") ? "missing" : "file"),
    probeCore: async (baseUrl) => {
      requested.push(baseUrl);
      return undefined;
    },
  });

  assert.equal(report.healthy, false);
  assert.deepEqual(requested, ["http://example.test:4517/ws"]);
  assert.match(formatDoctorReport(report), /\[FAIL\] Project:/);
  assert.match(formatDoctorReport(report), /\[FAIL\] Core:/);
  assert.match(formatDoctorReport(report), /Result: problems found$/);
});
