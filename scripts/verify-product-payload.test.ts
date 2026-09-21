import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { isolatedPayloadEnvironment } from "./verify-product-payload.ts";

test("payload smoke checks isolate product data on every target", () => {
  const root = join("C:", "temporary", "cinba-smoke");
  assert.deepEqual(isolatedPayloadEnvironment("windows-x64", root, { KEPT: "yes" }), {
    KEPT: "yes",
    LOCALAPPDATA: join(root, "local-app-data"),
    USERPROFILE: join(root, "home"),
  });
  assert.deepEqual(isolatedPayloadEnvironment("macos-arm64", root, { KEPT: "yes" }), {
    KEPT: "yes",
    HOME: join(root, "home"),
  });
  assert.deepEqual(isolatedPayloadEnvironment("linux-x64-gnu", root, { KEPT: "yes" }), {
    KEPT: "yes",
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_STATE_HOME: join(root, "xdg-state"),
  });
});
