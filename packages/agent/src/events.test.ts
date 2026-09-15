import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventFolder, foldUiRequest } from "./events.ts";

test("user and assistant messages each get a fresh id", () => {
  const fold = createEventFolder();

  assert.deepEqual(fold({ type: "message_start", message: { role: "user" } }), [
    { type: "message_added", messageId: "m1", role: "user", stableId: false },
  ]);
  assert.deepEqual(fold({ type: "message_start", message: { role: "assistant" } }), [
    { type: "message_added", messageId: "m2", role: "assistant", stableId: false },
  ]);
});

test("a user message arrives complete in message_start, so take the text there", () => {
  // An assistant message fills in through later text_delta events. A user
  // message has no such process: it appears this once, in message_start.
  // Miss it and you get a bubble that stays empty forever.
  const fold = createEventFolder();

  const actions = fold({
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  });

  assert.deepEqual(actions, [
    { type: "message_added", messageId: "m1", role: "user", stableId: false },
    { type: "text_appended", messageId: "m1", text: "hello" },
  ]);
});

test("an assistant message starts empty and produces no stray append action", () => {
  const fold = createEventFolder();

  assert.deepEqual(fold({ type: "message_start", message: { role: "assistant", content: [] } }), [
    { type: "message_added", messageId: "m1", role: "assistant", stableId: false },
  ]);
});

test("toolResult messages stay out of the transcript, since the tool card already shows them", () => {
  const fold = createEventFolder();

  assert.deepEqual(fold({ type: "message_start", message: { role: "toolResult" } }), []);
});

test("text_delta becomes an append onto the current message", () => {
  const fold = createEventFolder();
  fold({ type: "message_start", message: { role: "assistant" } });

  const actions = fold({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "hi" },
  });

  assert.deepEqual(actions, [{ type: "text_appended", messageId: "m1", text: "hi" }]);
});

test("thinking_delta travels on its own channel", () => {
  const fold = createEventFolder();
  fold({ type: "message_start", message: { role: "assistant" } });

  const actions = fold({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "let me think" },
  });

  assert.deepEqual(actions, [{ type: "thinking_appended", messageId: "m1", text: "let me think" }]);
});

test("unrecognized inner events are ignored", () => {
  const fold = createEventFolder();

  assert.deepEqual(
    fold({ type: "message_update", assistantMessageEvent: { type: "text_start" } }),
    [],
  );
});

test("events with missing or wrong fields are ignored safely", () => {
  const fold = createEventFolder();

  assert.deepEqual(
    fold({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "orphan" },
    }),
    [],
  );
  assert.deepEqual(fold({ type: "tool_execution_start", toolName: "bash" }), []);
  assert.deepEqual(fold({ type: "tool_execution_update", toolCallId: "call_1" }), []);
  assert.deepEqual(fold({ type: "tool_execution_end", toolCallId: "call_1" }), []);
  assert.deepEqual(
    fold({
      type: "message_end",
      message: { usage: { totalTokens: "many", cost: { total: "free" } } },
    }),
    [],
  );
});

test("tool_execution_start means running unless a confirmation arrives", () => {
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
      status: "running",
    },
  ]);
});

test("tool_execution_update replaces a running tool's accumulated output", () => {
  const fold = createEventFolder();

  const actions = fold({
    type: "tool_execution_update",
    toolCallId: "call_1",
    toolName: "bash",
    args: { command: "npm run check" },
    partialResult: {
      content: [{ type: "text", text: "format passed\nlint passed\n" }],
    },
  });

  assert.deepEqual(actions, [
    {
      type: "tool_changed",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "npm run check" },
      status: "running",
      result: "format passed\nlint passed\n",
    },
  ]);
});

test("tool_execution_end picks the final status from isError and extracts the text result", () => {
  const fold = createEventFolder();

  const ok = fold({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    isError: false,
    result: { content: [{ type: "text", text: "file contents" }] },
  });
  assert(ok[0]?.type === "tool_changed");
  assert.equal(ok[0].status, "done");
  assert.equal(ok[0].result, "file contents");

  const bad = fold({
    type: "tool_execution_end",
    toolCallId: "call_2",
    toolName: "bash",
    isError: true,
    result: { content: [{ type: "text", text: "The user denied this tool call" }] },
  });
  assert(bad[0]?.type === "tool_changed");
  assert.equal(bad[0].status, "error");
  assert.equal(bad[0].result, "The user denied this tool call");
});

test("cost and tokens accumulate across events", () => {
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

test("agent_start is what turns busy on", () => {
  // Busy and idle are both derivable from the event stream. Without this half,
  // every frontend has to patch busy:true in itself — once for the GUI, again
  // for the TUI, and the web UI would have needed a third. Three times means
  // the abstraction was missing a piece.
  const fold = createEventFolder();

  assert.deepEqual(fold({ type: "agent_start" }), [{ type: "busy_changed", busy: true }]);
});

test("agent_settled clears busy", () => {
  const fold = createEventFolder();

  assert.deepEqual(fold({ type: "agent_settled" }), [{ type: "busy_changed", busy: false }]);
});

test("queue updates replace the complete pending-message view", () => {
  const fold = createEventFolder();

  assert.deepEqual(
    fold({ type: "queue_update", steering: ["change direction"], followUp: ["then test"] }),
    [
      {
        type: "queue_changed",
        steering: ["change direction"],
        followUp: ["then test"],
      },
    ],
  );
  assert.deepEqual(fold({ type: "queue_update", steering: "wrong", followUp: [] }), []);
});

test("compaction stays visible from start through its estimated result", () => {
  const fold = createEventFolder();

  assert.deepEqual(fold({ type: "compaction_start", reason: "manual" }), [
    { type: "compaction_changed", compacting: true },
  ]);
  assert.deepEqual(
    fold({
      type: "compaction_end",
      reason: "manual",
      result: { tokensBefore: 120_000, estimatedTokensAfter: 28_000 },
      aborted: false,
    }),
    [
      {
        type: "compaction_changed",
        compacting: false,
        tokensBefore: 120_000,
        estimatedTokensAfter: 28_000,
      },
      { type: "notice", text: "Context compacted: 120,000 → ~28,000 tokens." },
    ],
  );
});

test("a confirm UI request becomes a confirm action; other kinds become nothing", () => {
  assert.deepEqual(
    foldUiRequest({
      type: "extension_ui_request",
      id: "u1",
      method: "confirm",
      title: "Allow bash?",
      message: "Rule: shell.delete\nReason: File deletion requires confirmation",
    }),
    {
      type: "confirm_requested",
      requestId: "u1",
      title: "Allow bash?",
      message: "Rule: shell.delete\nReason: File deletion requires confirmation",
    },
  );

  assert.equal(
    foldUiRequest({ type: "extension_ui_request", id: "u2", method: "notify" }),
    undefined,
  );
});
