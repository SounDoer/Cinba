import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";

test("the product TUI bundle excludes the product CLI entry point", async () => {
  const result = await build({
    absWorkingDir: resolve("."),
    entryPoints: ["packages/tui/src/index.ts"],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
    external: ["@earendil-works/pi-coding-agent"],
  });

  const inputs = Object.keys(result.metafile.inputs).map((path) => path.replaceAll("\\", "/"));
  assert.equal(
    inputs.some((path) => path.endsWith("/product-runtime/src/cli.ts")),
    false,
  );
});
