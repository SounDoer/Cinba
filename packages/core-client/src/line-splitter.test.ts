import { test } from "node:test";
import assert from "node:assert/strict";
import { createLineSplitter } from "./line-splitter.ts";

test("every line inside one chunk comes out", () => {
  const lines: string[] = [];
  const feed = createLineSplitter((line) => lines.push(line));

  feed('{"a":1}\n{"b":2}\n');

  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("a half line split across chunks is joined back together", () => {
  const lines: string[] = [];
  const feed = createLineSplitter((line) => lines.push(line));

  feed('{"a":');
  assert.deepEqual(lines, [], "no newline seen yet, so nothing should come out");

  feed("1}\n");
  assert.deepEqual(lines, ['{"a":1}']);
});

test("blank lines are ignored", () => {
  const lines: string[] = [];
  const feed = createLineSplitter((line) => lines.push(line));

  feed('\n\n{"a":1}\n');

  assert.deepEqual(lines, ['{"a":1}']);
});

test("Unicode line separators are not treated as newlines", () => {
  const lines: string[] = [];
  const feed = createLineSplitter((line) => lines.push(line));

  // U+2028 is a Unicode line separator. A general-purpose line reader would
  // cut here, splitting one complete JSON record in half. Model output can
  // contain this character.
  feed('{"text":"a\u2028b"}\n');

  assert.deepEqual(lines, ['{"text":"a\u2028b"}']);
});
