import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, isCommand, matchCommands } from "./commands.ts";

test("a slash makes it a command, anything else is something to say", () => {
  assert.equal(isCommand("/model"), true);
  assert.equal(isCommand("  /model"), true);
  assert.equal(isCommand("what does / mean"), false);
  assert.equal(isCommand(""), false);
});

test("a bare slash lists everything, which is what makes it a menu", () => {
  assert.equal(matchCommands("/").length, COMMANDS.length);
});

test("typing narrows the list", () => {
  assert.deepEqual(
    matchCommands("/se").map((command) => command.name),
    ["sessions"],
  );
  assert.deepEqual(matchCommands("/zzz"), []);
});

test("an exact name wins over one that merely starts with it", () => {
  // Guards the day a command is added whose name extends another's: "/new"
  // must keep meaning new, not new-something.
  const commands = matchCommands("/new");
  assert.equal(commands[0]?.name, "new");
});

test("something that is not a command matches nothing", () => {
  assert.deepEqual(matchCommands("hello"), []);
});
