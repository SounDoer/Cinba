import assert from "node:assert/strict";
import test from "node:test";
import { renderBundledLinuxInstaller, renderLinuxBootstrap } from "./linux-install-scripts.ts";

test("the bundled Linux installer delegates to the bundle's native launcher", () => {
  const script = renderBundledLinuxInstaller();
  assert.match(script, /^#!\/bin\/sh\nset -eu/);
  assert.match(script, /non-root user/);
  assert.match(script, /launcher\/cinba" install/);
  assert.doesNotMatch(script, /npm|nodejs|git clone/);
});

test("the remote Linux bootstrap is version locked and verifies before extraction", () => {
  const sha256 = "a".repeat(64);
  const script = renderLinuxBootstrap({
    version: "0.1.0",
    artifactName: "Cinba-0.1.0-linux-x64-gnu.tar.gz",
    artifactSha256: sha256,
  });
  assert.match(script, /releases\/download\/v0\.1\.0/);
  assert.match(script, new RegExp(sha256));
  assert.match(script, /sha256sum -c -[\s\S]*tar -xzf[\s\S]*install\.sh/);
  assert.doesNotMatch(script, /master|npm|nodejs|git clone/);
});

test("the Linux bootstrap renderer refuses untrusted release fields", () => {
  assert.throws(
    () =>
      renderLinuxBootstrap({
        version: "0.1.0-beta.1",
        artifactName: "Cinba-0.1.0-linux-x64-gnu.tar.gz",
        artifactSha256: "a".repeat(64),
      }),
    /stable SemVer/,
  );
  assert.throws(
    () =>
      renderLinuxBootstrap({
        version: "0.1.0",
        artifactName: "../Cinba.tar.gz",
        artifactSha256: "a".repeat(64),
      }),
    /artifact name/,
  );
});
