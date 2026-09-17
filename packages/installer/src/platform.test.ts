import assert from "node:assert/strict";
import test from "node:test";
import {
  PRODUCT_TARGET_DEFINITIONS,
  compareDottedVersions,
  productTargetFor,
  requireProductTarget,
} from "./platform.ts";

test("maps only the three supported platform and architecture pairs", () => {
  assert.equal(productTargetFor("win32", "x64"), "windows-x64");
  assert.equal(productTargetFor("darwin", "arm64"), "macos-arm64");
  assert.equal(productTargetFor("linux", "x64"), "linux-x64-gnu");

  assert.equal(productTargetFor("win32", "arm64"), undefined);
  assert.equal(productTargetFor("darwin", "x64"), undefined);
  assert.equal(productTargetFor("linux", "arm64"), undefined);
  assert.equal(productTargetFor("freebsd", "x64"), undefined);
});

test("publishes the first-release platform boundaries", () => {
  assert.deepEqual(PRODUCT_TARGET_DEFINITIONS["windows-x64"].minimumSystem, {
    platform: "windows",
    version: "10.0",
  });
  assert.deepEqual(PRODUCT_TARGET_DEFINITIONS["macos-arm64"].minimumSystem, {
    platform: "macos",
    version: "13.5",
  });
  assert.deepEqual(PRODUCT_TARGET_DEFINITIONS["linux-x64-gnu"].minimumSystem, {
    platform: "linux-gnu",
    kernel: "4.18",
    glibc: "2.28",
  });
});

test("reports an unsupported host instead of selecting a nearby artifact", () => {
  assert.throws(() => requireProductTarget("linux", "arm64"), {
    message: "Cinba does not support linux/arm64",
  });
});

test("compares dotted platform versions without lexical ordering mistakes", () => {
  assert.equal(compareDottedVersions("13.5", "13.5.0"), 0);
  assert.equal(compareDottedVersions("10.10", "10.9"), 1);
  assert.equal(compareDottedVersions("4.18", "5.4"), -1);
});
