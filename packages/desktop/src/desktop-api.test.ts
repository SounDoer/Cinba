import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopUpdatePresentation, createDesktopUpdateState } from "./desktop-api.ts";

test("Desktop update state keeps the latest value and broadcasts changes", () => {
  let broadcasts = 0;
  const state = createDesktopUpdateState(() => {
    broadcasts += 1;
  });

  assert.equal(state.get(), undefined);
  state.set({ phase: "checking" });
  assert.deepEqual(state.get(), { phase: "checking" });
  assert.equal(broadcasts, 1);
  state.set({ phase: "ready", candidateVersion: "0.2.0" });
  assert.deepEqual(state.get(), { phase: "ready", candidateVersion: "0.2.0" });
  assert.equal(broadcasts, 2);
});

test("Desktop update presentation is shared and hides inactive states", () => {
  assert.deepEqual(createDesktopUpdatePresentation("Cinba", undefined), {
    hidden: true,
    label: "",
  });
  assert.deepEqual(createDesktopUpdatePresentation("Cinba", { phase: "idle" }), {
    hidden: true,
    label: "",
  });
  assert.deepEqual(createDesktopUpdatePresentation("Cinba", { phase: "current" }), {
    hidden: true,
    label: "",
  });
  assert.deepEqual(createDesktopUpdatePresentation("Cinba Dev", { phase: "checking" }), {
    hidden: true,
    label: "",
  });
  assert.deepEqual(createDesktopUpdatePresentation("Cinba", { phase: "checking" }), {
    hidden: false,
    label: "Checking for Updates",
  });
  assert.deepEqual(createDesktopUpdatePresentation("Cinba", { phase: "downloading" }), {
    hidden: false,
    label: "Downloading Update",
  });
  assert.deepEqual(
    createDesktopUpdatePresentation("Cinba", {
      phase: "ready",
      candidateVersion: "0.2.0",
    }),
    { hidden: false, label: "Update 0.2.0 Ready" },
  );
});
