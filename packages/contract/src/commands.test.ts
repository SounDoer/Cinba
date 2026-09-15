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

test("web tools management has one discoverable top-level command", () => {
  assert.deepEqual(
    COMMANDS.filter((command) => command.name.startsWith("web")).map((command) => command.name),
    ["webtools"],
  );
  const matched = matchCommands("/webtools")[0];
  assert.equal(matched?.source, "cinba");
  assert.equal(matched?.source === "cinba" ? matched.id : undefined, "webtools");
});

test("Pi skills join the menu after Cinba commands", () => {
  const skills = [
    {
      source: "skill" as const,
      name: "skill:tdd",
      summary: "work test-first",
      scope: "user" as const,
    },
  ];

  assert.equal(matchCommands("/", skills).at(-1)?.name, "skill:tdd");
  assert.deepEqual(
    matchCommands("/skill:t", skills).map((command) => command.name),
    ["skill:tdd"],
  );
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
