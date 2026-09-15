import assert from "node:assert/strict";
import test from "node:test";
import type { CoreNavigatorState } from "./core-navigator.ts";
import type { CoreProfile } from "./profiles.ts";
import { createShellViewModel } from "./shell-view.ts";

const PROFILES: CoreProfile[] = [
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
];

test("an offline Core leaves switching and recovery actions available", () => {
  const connection: CoreNavigatorState = {
    type: "offline",
    profile: PROFILES[1]!,
    message: "VPS is unavailable",
  };

  assert.deepEqual(createShellViewModel(PROFILES, connection), {
    profiles: PROFILES,
    selectedProfileId: "vps",
    status: "offline",
    message: "VPS is unavailable",
    canRetry: true,
    canManage: true,
  });
});
