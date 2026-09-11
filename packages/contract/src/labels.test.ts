import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NAME_COLOURS,
  nameColourIndex,
  projectName,
  sessionSubtitle,
  sessionTitle,
} from "./labels.ts";
import type { SessionSummary } from "./protocol.ts";

const WINDOWS_PATH = ["C:", "Users", "me", "repos", "Cinba"].join("\\");

const base: SessionSummary = {
  id: "s1",
  cwd: WINDOWS_PATH,
  messageCount: 8,
  firstMessage: "how do I read this file",
  modified: "2026-09-08T02:49:01.045Z",
};

test("a project's name is its last path segment, on either platform", () => {
  assert.equal(projectName(WINDOWS_PATH), "Cinba");
  assert.equal(projectName("/home/me/repos/Cinba"), "Cinba");
  // A trailing slash must not turn the name into an empty string.
  assert.equal(projectName("/home/me/repos/Cinba/"), "Cinba");
});

test("a conversation is titled by its name, else its opening line", () => {
  assert.equal(sessionTitle(base), "how do I read this file");
  assert.equal(sessionTitle({ ...base, name: "parser work" }), "parser work");
  assert.equal(sessionTitle({ ...base, firstMessage: "" }), "(nothing said yet)");
});

test("the subtitle names the project, not the whole path", () => {
  // The terminal used to print the full path here while the browser printed the
  // name. One answer now, so they cannot drift apart again.
  assert.equal(sessionSubtitle(base), "Cinba · 8 messages");
});

test("a name always lands on the same colour, and different names spread out", () => {
  assert.equal(nameColourIndex("home"), nameColourIndex("home"));
  assert.ok(nameColourIndex("home") < NAME_COLOURS);
  assert.ok(nameColourIndex("") >= 0, "an empty name still lands somewhere rather than throwing");

  // Not a guarantee about any particular pair, but the machine names in play
  // here must be told apart, or the colour is decoration rather than a signal.
  assert.notEqual(nameColourIndex("IT-DES0200348"), nameColourIndex("vps"));
});
