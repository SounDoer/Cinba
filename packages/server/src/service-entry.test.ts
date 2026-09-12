import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveServiceRevision } from "./service-entry.ts";

const REVISION = "abcdef1234567890abcdef1234567890abcdef12";

test("the production service reads and normalizes its release worktree commit", () => {
  let receivedRoot = "";
  assert.equal(
    resolveServiceRevision("/home/cinba/current", (releaseRoot) => {
      receivedRoot = releaseRoot;
      return `${REVISION.toUpperCase()}\n`;
    }),
    REVISION,
  );
  assert.equal(receivedRoot, "/home/cinba/current");
});

test("the production service refuses to start without an exact commit", () => {
  assert.throws(() => resolveServiceRevision("/home/cinba/current", () => "HEAD\n"), /full Git/);
  assert.throws(() => resolveServiceRevision("/home/cinba/current", () => "\n"), /full Git/);
});
