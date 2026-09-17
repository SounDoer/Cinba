import assert from "node:assert/strict";
import test from "node:test";
import { TextInput } from "./settings-components.ts";

test("text input accepts bracketed terminal paste without storing control sequences", () => {
  const input = new TextInput("Sync Server URL");
  let answer: string | undefined;
  input.onAnswer = (value) => {
    answer = value;
  };

  input.handleInput("\x1b[200~https://sync.example.test:8443\x1b[201~");
  input.handleInput("\r");

  assert.equal(answer, "https://sync.example.test:8443");
});
