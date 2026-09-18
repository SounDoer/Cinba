import assert from "node:assert/strict";
import test from "node:test";
import {
  activateDesktopUpdate,
  createDesktopUpdatePresentation,
  createDesktopUpdateState,
} from "./desktop-api.ts";

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
    actionable: false,
    ariaLabel: "",
  });
  assert.deepEqual(createDesktopUpdatePresentation("Cinba", { phase: "idle" }), {
    hidden: true,
    label: "",
    actionable: false,
    ariaLabel: "",
  });
  assert.deepEqual(createDesktopUpdatePresentation("Cinba", { phase: "current" }), {
    hidden: true,
    label: "",
    actionable: false,
    ariaLabel: "",
  });
  assert.deepEqual(createDesktopUpdatePresentation("Cinba Dev", { phase: "checking" }), {
    hidden: true,
    label: "",
    actionable: false,
    ariaLabel: "",
  });
  assert.deepEqual(createDesktopUpdatePresentation("Cinba", { phase: "checking" }), {
    hidden: false,
    label: "Checking for Updates",
    actionable: false,
    ariaLabel: "Checking for Cinba updates",
  });
  assert.deepEqual(createDesktopUpdatePresentation("Cinba", { phase: "downloading" }), {
    hidden: false,
    label: "Downloading Update",
    actionable: false,
    ariaLabel: "Downloading a Cinba update",
  });
  assert.deepEqual(
    createDesktopUpdatePresentation("Cinba", {
      phase: "ready",
      candidateVersion: "0.2.0",
    }),
    {
      hidden: false,
      label: "Update 0.2.0 Ready",
      actionable: true,
      ariaLabel: "Install Cinba 0.2.0 and restart",
    },
  );
  assert.deepEqual(
    createDesktopUpdatePresentation("Cinba", {
      phase: "failed",
      candidateVersion: "0.2.0",
      message: "Cinba 0.2.0 could not be installed. Run cinba update to retry.",
    }),
    {
      hidden: false,
      label: "Update 0.2.0 Failed",
      actionable: false,
      ariaLabel: "Cinba 0.2.0 update installation failed",
    },
  );
  assert.deepEqual(
    createDesktopUpdatePresentation("Cinba", {
      phase: "blocked",
      reason: "incompatible",
      candidateVersion: "0.2.0",
      message: "details",
    }),
    {
      hidden: false,
      label: "Update 0.2.0 Requires a Newer System",
      actionable: false,
      ariaLabel: "Cinba 0.2.0 requires a newer system",
    },
  );
  assert.deepEqual(
    createDesktopUpdatePresentation("Cinba", {
      phase: "blocked",
      reason: "unverified",
      candidateVersion: "0.2.0",
      message: "details",
    }),
    {
      hidden: false,
      label: "Update 0.2.0 Compatibility Unknown",
      actionable: false,
      ariaLabel: "Cinba 0.2.0 system compatibility is unknown",
    },
  );
});

test("Desktop update activation calls install only for an actionable ready update", async () => {
  let installs = 0;
  const install = async () => {
    installs += 1;
  };

  await activateDesktopUpdate(
    createDesktopUpdatePresentation("Cinba", { phase: "checking" }),
    install,
  );
  await activateDesktopUpdate(
    createDesktopUpdatePresentation("Cinba", {
      phase: "ready",
      candidateVersion: "0.2.0",
    }),
    install,
  );

  assert.equal(installs, 1);
});
