import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventFolder, foldUiRequest } from "./events.ts";

test("user 与 assistant 消息各拿到一个新 id", () => {
  const fold = createEventFolder();

  assert.deepEqual(fold({ type: "message_start", message: { role: "user" } }), [
    { type: "message_added", messageId: "m1", role: "user" },
  ]);
  assert.deepEqual(fold({ type: "message_start", message: { role: "assistant" } }), [
    { type: "message_added", messageId: "m2", role: "assistant" },
  ]);
});

test("用户消息的正文在 message_start 里就已经完整，必须一并取出", () => {
  // 助手消息的正文靠后续的 text_delta 一点点填，用户消息没有那个过程——
  // 只在 message_start 出现这一次。漏掉就是个永远空着的气泡。
  const fold = createEventFolder();

  const actions = fold({
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "你好" }] },
  });

  assert.deepEqual(actions, [
    { type: "message_added", messageId: "m1", role: "user" },
    { type: "text_appended", messageId: "m1", text: "你好" },
  ]);
});

test("助手消息开始时正文为空，不产生多余的追加动作", () => {
  const fold = createEventFolder();

  assert.deepEqual(fold({ type: "message_start", message: { role: "assistant", content: [] } }), [
    { type: "message_added", messageId: "m1", role: "assistant" },
  ]);
});

test("toolResult 消息不进消息流（内容已在工具卡片上）", () => {
  const fold = createEventFolder();

  assert.deepEqual(fold({ type: "message_start", message: { role: "toolResult" } }), []);
});

test("text_delta 变成往当前消息追加文字", () => {
  const fold = createEventFolder();
  fold({ type: "message_start", message: { role: "assistant" } });

  const actions = fold({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "好" },
  });

  assert.deepEqual(actions, [{ type: "text_appended", messageId: "m1", text: "好" }]);
});

test("thinking_delta 走单独的通道", () => {
  const fold = createEventFolder();
  fold({ type: "message_start", message: { role: "assistant" } });

  const actions = fold({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "让我想想" },
  });

  assert.deepEqual(actions, [{ type: "thinking_appended", messageId: "m1", text: "让我想想" }]);
});

test("不认识的内层事件被忽略", () => {
  const fold = createEventFolder();

  assert.deepEqual(
    fold({ type: "message_update", assistantMessageEvent: { type: "text_start" } }),
    [],
  );
});

test("tool_execution_start 只能是待批准，绝不是已执行", () => {
  const fold = createEventFolder();

  const actions = fold({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "bash",
    args: { command: "ls" },
  });

  assert.deepEqual(actions, [
    {
      type: "tool_changed",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "ls" },
      status: "pending",
    },
  ]);
});

test("tool_execution_end 按 isError 决定终态，并抽出文本结果", () => {
  const fold = createEventFolder();

  const ok = fold({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    isError: false,
    result: { content: [{ type: "text", text: "文件内容" }] },
  });
  assert.equal(ok[0].status, "done");
  assert.equal(ok[0].result, "文件内容");

  const bad = fold({
    type: "tool_execution_end",
    toolCallId: "call_2",
    toolName: "bash",
    isError: true,
    result: { content: [{ type: "text", text: "用户拒绝了这次工具调用" }] },
  });
  assert.equal(bad[0].status, "error");
  assert.equal(bad[0].result, "用户拒绝了这次工具调用");
});

test("费用与 token 逐条累加", () => {
  const fold = createEventFolder();

  const first = fold({
    type: "message_end",
    message: { role: "assistant", usage: { totalTokens: 100, cost: { total: 0.001 } } },
  });
  assert.deepEqual(first, [{ type: "usage_changed", totalTokens: 100, totalCost: 0.001 }]);

  const second = fold({
    type: "message_end",
    message: { role: "assistant", usage: { totalTokens: 50, cost: { total: 0.002 } } },
  });
  assert.deepEqual(second, [{ type: "usage_changed", totalTokens: 150, totalCost: 0.003 }]);
});

test("agent_start 就是「开始忙」", () => {
  // 忙 / 不忙本来就能从事件流推出来。少了这一半，每个前端都得自己补一句
  // busy:true——GUI 补过、TUI 补过、网页版还要再补。三遍就是抽象漏了一块。
  const fold = createEventFolder();

  assert.deepEqual(fold({ type: "agent_start" }), [{ type: "busy_changed", busy: true }]);
});

test("agent_settled 解除忙碌", () => {
  const fold = createEventFolder();

  assert.deepEqual(fold({ type: "agent_settled" }), [{ type: "busy_changed", busy: false }]);
});

test("confirm 类 UI 请求变成确认动作，其余不变成任何动作", () => {
  assert.deepEqual(
    foldUiRequest({ type: "extension_ui_request", id: "u1", method: "confirm" }),
    { type: "confirm_requested", requestId: "u1" },
  );

  assert.equal(
    foldUiRequest({ type: "extension_ui_request", id: "u2", method: "notify" }),
    undefined,
  );
});
