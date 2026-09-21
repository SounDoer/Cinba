import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { createDesktopBuildConfiguration } from "./build-desktop-app.ts";

test("Desktop packaging is a stable shell without an embedded release or updater", () => {
  const output = resolve("output");
  const config = createDesktopBuildConfiguration({
    version: "0.1.0",
    outputDirectory: output,
  });
  assert.equal(config.appId, "com.soundoer.cinba");
  assert.equal(config.productName, "Cinba");
  assert.equal(config.extraResources, undefined);
  assert.equal(config.electronDist, undefined);
  assert.equal(config.win?.signExecutable, false);
  assert.equal(config.mac?.identity, "-");
  assert.equal(config.mac?.hardenedRuntime, false);
});
