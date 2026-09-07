import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "./session.ts";

test("新会话是空的、不忙", () => {
  const session = createSession();

  assert.deepEqual(session.snapshot(), {
    entries: [],
    totalTokens: 0,
    totalCost: 0,
    busy: false,
  });
});

test("消息按到达顺序进条目表，文字逐段追加", () => {
  const session = createSession();

  session.apply({ type: "message_added", messageId: "m1", role: "assistant" });
  session.apply({ type: "text_appended", messageId: "m1", text: "你" });
  session.apply({ type: "text_appended", messageId: "m1", text: "好" });

  assert.deepEqual(session.snapshot().entries, [
    { kind: "message", messageId: "m1", role: "assistant", text: "你好", thinking: "" },
  ]);
});

test("thinking 与正文分开存", () => {
  const session = createSession();

  session.apply({ type: "message_added", messageId: "m1", role: "assistant" });
  session.apply({ type: "thinking_appended", messageId: "m1", text: "想一下" });
  session.apply({ type: "text_appended", messageId: "m1", text: "答案" });

  const entry = session.snapshot().entries[0];
  assert.equal(entry.text, "答案");
  assert.equal(entry.thinking, "想一下");
});

test("往不存在的消息上追加文字会被忽略，不崩", () => {
  const session = createSession();

  session.apply({ type: "text_appended", messageId: "不存在", text: "x" });

  assert.deepEqual(session.snapshot().entries, []);
});

test("工具卡片按 toolCallId 更新，不新增条目", () => {
  const session = createSession();

  session.apply({
    type: "tool_changed",
    toolCallId: "call_1",
    toolName: "bash",
    args: { command: "ls" },
    status: "pending",
  });
  session.apply({
    type: "tool_changed",
    toolCallId: "call_1",
    toolName: "bash",
    status: "done",
    result: "输出",
  });

  assert.deepEqual(session.snapshot().entries, [
    {
      kind: "tool",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "ls" },
      status: "done",
      result: "输出",
      confirmRequestId: undefined,
    },
  ]);
});

test("两个并发工具各占一张卡片", () => {
  const session = createSession();

  session.apply({ type: "tool_changed", toolCallId: "a", toolName: "read", status: "pending" });
  session.apply({ type: "tool_changed", toolCallId: "b", toolName: "grep", status: "pending" });

  assert.equal(session.snapshot().entries.length, 2);
});

test("确认请求挂到最近一张待批准的卡片上", () => {
  const session = createSession();

  session.apply({ type: "tool_changed", toolCallId: "a", toolName: "read", status: "done" });
  session.apply({ type: "tool_changed", toolCallId: "b", toolName: "bash", status: "pending" });
  session.apply({ type: "confirm_requested", requestId: "u1" });

  const entries = session.snapshot().entries;
  assert.equal(entries[0].confirmRequestId, undefined, "已完成的卡片不该被挂上确认");
  assert.equal(entries[1].confirmRequestId, "u1");
});

test("确认被回答后卡片上的待确认标记清除", () => {
  const session = createSession();

  session.apply({ type: "tool_changed", toolCallId: "b", toolName: "bash", status: "pending" });
  session.apply({ type: "confirm_requested", requestId: "u1" });
  session.apply({ type: "tool_changed", toolCallId: "b", toolName: "bash", status: "running" });

  assert.equal(session.snapshot().entries[0].confirmRequestId, undefined);
  assert.equal(session.snapshot().entries[0].status, "running");
});

test("系统提示作为独立条目进账本", () => {
  // 「已中止」这类提示必须进账本，不能只在界面上打一行——
  // 否则 GUI 刷新一下就没了，用户会以为什么都没发生过。
  const session = createSession();

  session.apply({ type: "message_added", messageId: "m1", role: "assistant" });
  session.apply({ type: "notice", text: "已中止" });

  assert.deepEqual(session.snapshot().entries[1], { kind: "notice", text: "已中止" });
});

test("费用与忙碌状态记在快照上", () => {
  const session = createSession();

  session.apply({ type: "busy_changed", busy: true });
  session.apply({ type: "usage_changed", totalTokens: 120, totalCost: 0.0042 });

  const snapshot = session.snapshot();
  assert.equal(snapshot.busy, true);
  assert.equal(snapshot.totalTokens, 120);
  assert.equal(snapshot.totalCost, 0.0042);
});

test("快照是副本，改它不影响账本", () => {
  const session = createSession();
  session.apply({ type: "message_added", messageId: "m1", role: "user" });

  const snapshot = session.snapshot();
  snapshot.entries.length = 0;

  assert.equal(session.snapshot().entries.length, 1);
});

test("可以从一份快照重建账本", () => {
  // 客户端侧持有的是镜像：拿服务器给的快照开局，之后跟着动作走。
  const origin = createSession();
  origin.apply({ type: "message_added", messageId: "m1", role: "user" });
  origin.apply({ type: "text_appended", messageId: "m1", text: "你好" });
  origin.apply({ type: "usage_changed", totalTokens: 120, totalCost: 0.004 });

  const mirror = createSession(origin.snapshot());

  assert.deepEqual(mirror.snapshot(), origin.snapshot());
});

test("重建出来的账本能继续接收动作", () => {
  const origin = createSession();
  origin.apply({ type: "message_added", messageId: "m1", role: "assistant" });

  const mirror = createSession(origin.snapshot());
  mirror.apply({ type: "text_appended", messageId: "m1", text: "继续" });

  assert.equal(mirror.snapshot().entries[0].text, "继续");
});
