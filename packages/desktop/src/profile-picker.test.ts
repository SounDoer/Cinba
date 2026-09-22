import assert from "node:assert/strict";
import test from "node:test";
import { syncProfilePicker } from "./profile-picker.ts";
import type { CoreProfile } from "./profiles.ts";

const PROFILES: CoreProfile[] = [
  {
    id: "local",
    kind: "local",
    label: "This Mac",
    baseUrl: "http://127.0.0.1:4517/",
  },
  {
    id: "vps",
    kind: "remote",
    label: "VPS",
    baseUrl: "https://cinba-vps.test/",
  },
];

test("the Core picker follows state after reusing its existing options", () => {
  const local = { value: "local", textContent: "This Mac" };
  const vps = { value: "vps", textContent: "VPS" };
  const picker = {
    options: [local, vps],
    value: "vps",
    replaceChildren(...options: (typeof local)[]) {
      this.options = options;
    },
  };

  syncProfilePicker(
    picker.options,
    PROFILES,
    "local",
    () => ({ value: "", textContent: "" }),
    (options) => picker.replaceChildren(...options),
    (profileId) => {
      picker.value = profileId;
    },
  );

  assert.equal(picker.value, "local");
  assert.deepEqual(picker.options, [local, vps]);
});
