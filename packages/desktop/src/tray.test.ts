import assert from "node:assert/strict";
import test from "node:test";
import { createCoreMenuItems, createTrayBitmap, createTrayViewModel } from "./tray.ts";

test("tray icons are non-empty BGRA bitmaps with transparent corners", () => {
  for (const tone of ["stopped", "running", "busy", "error"] as const) {
    const bitmap = createTrayBitmap(tone);
    assert.equal(bitmap.length, 16 * 16 * 4);
    assert.equal(bitmap[3], 0);
    assert.ok(
      Array.from({ length: 16 * 16 }, (_, index) => bitmap[index * 4 + 3]).some(
        (alpha) => alpha === 255,
      ),
    );
  }
});

test("a stopped Core can be started", () => {
  assert.deepEqual(createTrayViewModel({ state: "stopped", running: false, managed: false }), {
    tooltip: "Cinba Local Core: stopped",
    iconTone: "stopped",
    statusLabel: "Local Core: stopped",
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

  assert.equal(view.statusLabel, "Local Core: running");
  assert.equal(view.iconTone, "running");
  assert.deepEqual(view.detailLabels, [
    "PID: 4517",
    "Clients: 2",
    "Availability: stops after 10 idle minutes",
    "Core is busy; stopping will drain current work",
  ]);
  assert.equal(view.canStart, false);
  assert.equal(view.canStop, true);
});

test("a persistent Core explains that only the user stops it", () => {
  const view = createTrayViewModel({
    state: "running",
    running: true,
    managed: true,
    lifetime: "persistent",
    safeToStop: true,
  });

  assert.deepEqual(view.detailLabels, ["Availability: until you stop the Core"]);
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

  assert.equal(view.statusLabel, "Local Core: external");
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
  assert.equal(starting.statusLabel, "Local Core: starting");
  assert.equal(starting.canStart, false);
});

test("an error is shown without discarding the last known status", () => {
  const view = createTrayViewModel(
    { state: "running", running: true, managed: true },
    undefined,
    "request timed out",
  );

  assert.equal(view.statusLabel, "Local Core: running");
  assert.equal(view.iconTone, "error");
  assert.deepEqual(view.detailLabels, ["Error: request timed out"]);
});

test("the Open Core menu lists local and remote profiles", () => {
  assert.deepEqual(
    createCoreMenuItems(
      [
        {
          id: "local",
          kind: "local",
          label: "This PC",
          baseUrl: "http://127.0.0.1:4517/",
        },
        {
          id: "vps",
          kind: "remote",
          label: "VPS",
          baseUrl: "https://cinba-vps.test/",
        },
      ],
      "vps",
    ),
    [
      { profileId: "local", label: "This PC", selected: false },
      { profileId: "vps", label: "VPS", selected: true },
    ],
  );
});
