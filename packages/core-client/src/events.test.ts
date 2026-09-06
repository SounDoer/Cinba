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
