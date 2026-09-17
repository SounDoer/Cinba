import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveProductPayloadLayout } from "./layout.ts";

test("all product entries stay relative to one movable payload", () => {
  const root = resolve("release");
  const layout = resolveProductPayloadLayout(root, "win32");
  assert.equal(layout.cliEntry, join(root, "lib", "cli.mjs"));
  assert.equal(layout.coreEntry, join(root, "lib", "core.mjs"));
  assert.equal(layout.tuiEntry, join(root, "lib", "tui.mjs"));
  assert.equal(layout.syncEntry, join(root, "lib", "sync.mjs"));
  assert.equal(layout.nodeExecutable, join(root, "runtime", "node.exe"));
});

test("a payload root must be explicit and absolute", () => {
  assert.throws(() => resolveProductPayloadLayout("release"), {
    message: "product payload root must be an absolute path",
  });
});
