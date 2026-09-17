import assert from "node:assert/strict";
import test from "node:test";
import { parseProductRelease } from "./release.ts";

const RELEASE = {
  schemaVersion: 1,
  product: "Cinba",
  version: "1.2.3",
  revision: "abcdef1234567890abcdef1234567890abcdef12",
  protocolVersion: 1,
  dataFormatVersion: 1,
  target: "windows-x64",
  nodeVersion: "24.19.0",
};

test("a payload release has one strict build-time identity", () => {
  assert.deepEqual(parseProductRelease(RELEASE), RELEASE);
});

test("payload identity cannot fall back to Git or accept unknown fields", () => {
  assert.throws(() => parseProductRelease({ ...RELEASE, revision: "unknown" }), {
    message: "product release revision must be a full lowercase Git commit",
  });
  assert.throws(() => parseProductRelease({ ...RELEASE, branch: "master" }), {
    message: "product release contains unknown field branch",
  });
});
