import assert from "node:assert/strict";
import test from "node:test";
import { createTrayViewModel } from "./tray.ts";

test("a stopped Core can be started", () => {
  assert.deepEqual(createTrayViewModel({ state: "stopped", running: false, managed: false }), {
    tooltip: "Cinba Core: stopped",
    iconTone: "stopped",
    statusLabel: "Core: stopped",
    detailLabels: [],
    canStart: true,
    canStop: false,
  });
});

test("a managed Core exposes its details and graceful stop", () => {
  const view = createTrayViewModel({
    state: "running",
    running: true,
    managed: true,
    pid: 4517,
    lifetime: "on-demand",
    clientCount: 2,
    safeToStop: false,
  });

  assert.equal(view.statusLabel, "Core: running");
  assert.equal(view.iconTone, "running");
  assert.deepEqual(view.detailLabels, [
    "PID: 4517",
    "Clients: 2",
    "Core is busy; stopping will drain current work",
  ]);
  assert.equal(view.canStart, false);
  assert.equal(view.canStop, true);
});

test("an external Core is visible but cannot be stopped", () => {
  const view = createTrayViewModel({
    state: "running",
    running: true,
    managed: false,
    lifetime: "external",
    safeToStop: true,
  });

  assert.equal(view.statusLabel, "Core: external");
  assert.equal(view.canStop, false);
});

test("draining and transient operations disable both controls", () => {
  const draining = createTrayViewModel({
    state: "draining",
    running: true,
    managed: true,
  });
  const starting = createTrayViewModel(
    { state: "stopped", running: false, managed: false },
    "starting",
  );

  assert.equal(draining.iconTone, "busy");
  assert.equal(draining.canStop, false);
  assert.equal(starting.statusLabel, "Core: starting");
  assert.equal(starting.canStart, false);
});

test("an error is shown without discarding the last known status", () => {
  const view = createTrayViewModel(
    { state: "running", running: true, managed: true },
    undefined,
    "request timed out",
  );

  assert.equal(view.statusLabel, "Core: running");
  assert.equal(view.iconTone, "error");
  assert.deepEqual(view.detailLabels, ["Error: request timed out"]);
});
