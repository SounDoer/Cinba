import assert from "node:assert/strict";
import test from "node:test";
import { createCoreNavigator } from "./core-navigator.ts";
import type { LocalCoreProfile, RemoteCoreProfile } from "./profiles.ts";

const VPS: RemoteCoreProfile = {
  id: "vps",
  kind: "remote",
  label: "VPS",
  baseUrl: "https://cinba-vps.test/",
};

const LOCAL: LocalCoreProfile = {
  id: "local",
  kind: "local",
  label: "This PC",
  baseUrl: "http://127.0.0.1:4517/",
};

test("a remote Core opens without requiring the local Core", async () => {
  const navigator = createCoreNavigator({
    ensureLocal: async () => {
      throw new Error("local Core must not start");
    },
    probe: async () => true,
    load: async () => {},
  });

  assert.deepEqual(await navigator.open(VPS), {
    type: "online",
    profile: VPS,
  });
});

test("the local Core is made available before it opens", async () => {
  let ready = false;
  const navigator = createCoreNavigator({
    ensureLocal: async () => {
      ready = true;
    },
    probe: async () => ready,
    load: async () => {},
  });

  assert.deepEqual(await navigator.open(LOCAL), {
    type: "online",
    profile: LOCAL,
  });
});

test("an unavailable Core stays selected without loading another Core", async () => {
  const navigator = createCoreNavigator({
    ensureLocal: async () => {},
    probe: async () => false,
    load: async () => {
      throw new Error("an unavailable Core must not load");
    },
  });

  assert.deepEqual(await navigator.open(VPS), {
    type: "offline",
    profile: VPS,
    message: "VPS is unavailable",
  });
});

test("a slow old Core cannot replace a newer selection", async () => {
  let finishVpsProbe: ((reachable: boolean) => void) | undefined;
  let loadedUrl = "";
  const navigator = createCoreNavigator({
    ensureLocal: async () => {},
    probe: async (baseUrl) =>
      baseUrl === VPS.baseUrl
        ? await new Promise<boolean>((resolve) => {
            finishVpsProbe = resolve;
          })
        : true,
    load: async (baseUrl) => {
      loadedUrl = baseUrl;
    },
  });

  const oldOpen = navigator.open(VPS);
  await Promise.resolve();
  await navigator.open(LOCAL);
  finishVpsProbe?.(true);
  await oldOpen;

  assert.deepEqual(
    { state: navigator.current(), loadedUrl },
    { state: { type: "online", profile: LOCAL }, loadedUrl: LOCAL.baseUrl },
  );
});

test("a connection error becomes an actionable offline state", async () => {
  const navigator = createCoreNavigator({
    ensureLocal: async () => {},
    probe: async () => {
      throw new Error("Tailscale is unavailable");
    },
    load: async () => {},
  });

  assert.deepEqual(await navigator.open(VPS), {
    type: "offline",
    profile: VPS,
    message: "Tailscale is unavailable",
  });
});

test("the selected Core is visible while its connection is opening", async () => {
  let finishProbe: ((reachable: boolean) => void) | undefined;
  const navigator = createCoreNavigator({
    ensureLocal: async () => {},
    probe: async () =>
      await new Promise<boolean>((resolve) => {
        finishProbe = resolve;
      }),
    load: async () => {},
  });

  const opening = navigator.open(VPS);
  await Promise.resolve();
  const visible = navigator.current();
  finishProbe?.(true);
  await opening;

  assert.deepEqual(visible, { type: "opening", profile: VPS });
});
