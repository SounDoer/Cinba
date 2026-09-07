import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClientMessage } from "./protocol.ts";

test("认得四种客户端消息", () => {
  assert.deepEqual(parseClientMessage({ type: "prompt", text: "你好" }), {
    type: "prompt",
    text: "你好",
  });
  assert.deepEqual(parseClientMessage({ type: "abort" }), { type: "abort" });
  assert.deepEqual(
    parseClientMessage({ type: "respond_confirm", requestId: "u1", confirmed: true }),
    { type: "respond_confirm", requestId: "u1", confirmed: true },
  );
  assert.deepEqual(parseClientMessage({ type: "set_project", cwd: "/tmp" }), {
    type: "set_project",
    cwd: "/tmp",
  });
});

test("认得 list_dir", () => {
  assert.deepEqual(parseClientMessage({ type: "list_dir", path: "C:\\Users" }), {
    type: "list_dir",
    path: "C:\\Users",
  });
});

test("list_dir 的 path 必须是非空字符串", () => {
  assert.equal(parseClientMessage({ type: "list_dir" }), undefined);
  assert.equal(parseClientMessage({ type: "list_dir", path: "" }), undefined);
  assert.equal(parseClientMessage({ type: "list_dir", path: 42 }), undefined);
});

test("字段类型不对的一律丢掉", () => {
  // 网络来的东西不可信。宁可丢掉也不能带着错的类型往下走。
  assert.equal(parseClientMessage({ type: "prompt", text: 123 }), undefined);
  assert.equal(parseClientMessage({ type: "respond_confirm", requestId: "u1" }), undefined);
  assert.equal(
    parseClientMessage({ type: "respond_confirm", requestId: 1, confirmed: true }),
    undefined,
  );
  assert.equal(parseClientMessage({ type: "set_project", cwd: "" }), undefined);
});

test("空白的 prompt 不算数", () => {
  assert.equal(parseClientMessage({ type: "prompt", text: "   " }), undefined);
});

test("不认识的东西丢掉，不崩", () => {
  assert.equal(parseClientMessage({ type: "rm -rf /" }), undefined);
  assert.equal(parseClientMessage(null), undefined);
  assert.equal(parseClientMessage("prompt"), undefined);
  assert.equal(parseClientMessage(42), undefined);
});
