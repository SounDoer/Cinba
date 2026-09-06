import { test } from "node:test";
import assert from "node:assert/strict";
import { createLineSplitter } from "./line-splitter.ts";

test("一个 chunk 里的多行全部切出", () => {
  const lines: string[] = [];
  const feed = createLineSplitter((line) => lines.push(line));

  feed('{"a":1}\n{"b":2}\n');

  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("跨 chunk 的半行会被拼回来", () => {
  const lines: string[] = [];
  const feed = createLineSplitter((line) => lines.push(line));

  feed('{"a":');
  assert.deepEqual(lines, [], "还没遇到换行，不该吐出任何东西");

  feed("1}\n");
  assert.deepEqual(lines, ['{"a":1}']);
});

test("空行被忽略", () => {
  const lines: string[] = [];
  const feed = createLineSplitter((line) => lines.push(line));

  feed('\n\n{"a":1}\n');

  assert.deepEqual(lines, ['{"a":1}']);
});

test("不把 Unicode 行分隔符当换行", () => {
  const lines: string[] = [];
  const feed = createLineSplitter((line) => lines.push(line));

  // \u2028 是 Unicode 行分隔符。通用行读取器会在这里切一刀，
  // 把一条完整 JSON 切成两半。模型输出里完全可能出现这个字符。
  feed('{"text":"a\u2028b"}\n');

  assert.deepEqual(lines, ['{"text":"a\u2028b"}']);
});
