import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { createDesktopBuildConfiguration } from "./build-desktop-app.ts";

test("Desktop packaging embeds one release payload without an independent updater", () => {
  const payload = resolve("payload");
  const output = resolve("output");
  const config = createDesktopBuildConfiguration({
    version: "0.1.0",
    payloadDirectory: payload,
    outputDirectory: output,
  });
  assert.equal(config.appId, "com.soundoer.cinba");
  assert.equal(config.productName, "Cinba");
  assert.deepEqual(config.extraResources, [{ from: payload, to: "payload" }]);
  assert.equal(config.win?.signExecutable, false);
  assert.equal(config.mac?.identity, null);
});
