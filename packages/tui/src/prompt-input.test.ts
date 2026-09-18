import assert from "node:assert/strict";
import test from "node:test";
import { PromptInput, createTuiLocalCommands } from "./prompt-input.ts";

const updateSkill = {
  source: "skill" as const,
  name: "update",
  summary: "skill must not shadow local update",
  scope: "project" as const,
};

test("installed local update command appears in the slash menu and is used for exact input", () => {
  const prompt = new PromptInput();
  prompt.setTuiCommands(createTuiLocalCommands(true));
  for (const key of "/update") {
    prompt.handleInput(key);
  }

  assert.deepEqual(prompt.pending(), {
    source: "tui",
    name: "update",
    summary: "install the ready update and restart",
  });
  assert.match(prompt.render(100).join("\n"), /\/update.*install the ready update and restart/);
});

test("local commands win over same-named skills without treating arguments as update", () => {
  const prompt = new PromptInput();
  prompt.setSkills([updateSkill]);
  prompt.setTuiCommands(createTuiLocalCommands(true));
  for (const key of "/update") {
    prompt.handleInput(key);
  }

  assert.equal(prompt.pending()?.source, "tui");
  assert.doesNotMatch(prompt.render(100).join("\n"), /skill must not shadow/);

  prompt.input.setValue("/update now");
  prompt.setTuiCommands(createTuiLocalCommands(true));
  assert.equal(prompt.pending(), undefined);
});

test("development TUI does not register installed local commands", () => {
  assert.deepEqual(createTuiLocalCommands(false), []);
});

test("installed local command catalogue supplies the update help entry", () => {
  assert.deepEqual(
    createTuiLocalCommands(true).map((command) => `/${command.name}  ${command.summary}`),
    ["/update  install the ready update and restart"],
  );
});
