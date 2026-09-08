import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "./session.ts";

test("a fresh session is empty and not busy", () => {
  const session = createSession();

  assert.deepEqual(session.snapshot(), {
    entries: [],
    totalTokens: 0,
    totalCost: 0,
    busy: false,
  });
});

test("messages enter the ledger in arrival order and text appends piece by piece", () => {
  const session = createSession();

  session.apply({ type: "message_added", messageId: "m1", role: "assistant" });
  session.apply({ type: "text_appended", messageId: "m1", text: "he" });
  session.apply({ type: "text_appended", messageId: "m1", text: "llo" });

  assert.deepEqual(session.snapshot().entries, [
    { kind: "message", messageId: "m1", role: "assistant", text: "hello", thinking: "" },
  ]);
});

test("thinking is stored separately from the body text", () => {
  const session = createSession();

  session.apply({ type: "message_added", messageId: "m1", role: "assistant" });
  session.apply({ type: "thinking_appended", messageId: "m1", text: "thinking it over" });
  session.apply({ type: "text_appended", messageId: "m1", text: "the answer" });

  const entry = session.snapshot().entries[0];
  assert.equal(entry.text, "the answer");
  assert.equal(entry.thinking, "thinking it over");
});

test("appending to a message that does not exist is ignored rather than crashing", () => {
  const session = createSession();

  session.apply({ type: "text_appended", messageId: "no-such-message", text: "x" });

  assert.deepEqual(session.snapshot().entries, []);
});

test("a tool card updates in place by toolCallId instead of adding an entry", () => {
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
    result: "output",
  });

  assert.deepEqual(session.snapshot().entries, [
    {
      kind: "tool",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "ls" },
      status: "done",
      result: "output",
      confirmRequestId: undefined,
    },
  ]);
});

test("two concurrent tools get one card each", () => {
  const session = createSession();

  session.apply({ type: "tool_changed", toolCallId: "a", toolName: "read", status: "pending" });
  session.apply({ type: "tool_changed", toolCallId: "b", toolName: "grep", status: "pending" });

  assert.equal(session.snapshot().entries.length, 2);
});

test("a confirm request attaches to the most recent pending card", () => {
  const session = createSession();

  session.apply({ type: "tool_changed", toolCallId: "a", toolName: "read", status: "done" });
  session.apply({ type: "tool_changed", toolCallId: "b", toolName: "bash", status: "pending" });
  session.apply({ type: "confirm_requested", requestId: "u1" });

  const entries = session.snapshot().entries;
  assert.equal(entries[0].confirmRequestId, undefined, "a finished card must not have a confirmation attached");
  assert.equal(entries[1].confirmRequestId, "u1");
});

test("answering a confirmation clears the pending marker on the card", () => {
  const session = createSession();

  session.apply({ type: "tool_changed", toolCallId: "b", toolName: "bash", status: "pending" });
  session.apply({ type: "confirm_requested", requestId: "u1" });
  session.apply({ type: "tool_changed", toolCallId: "b", toolName: "bash", status: "running" });

  assert.equal(session.snapshot().entries[0].confirmRequestId, undefined);
  assert.equal(session.snapshot().entries[0].status, "running");
});

test("a system notice enters the ledger as its own entry", () => {
  // A notice like "aborted" has to enter the ledger rather than just being
  // printed to the screen. Otherwise a GUI reload loses it and the user thinks
  // nothing ever happened.
  const session = createSession();

  session.apply({ type: "message_added", messageId: "m1", role: "assistant" });
  session.apply({ type: "notice", text: "aborted" });

  assert.deepEqual(session.snapshot().entries[1], { kind: "notice", text: "aborted" });
});

test("cost and busy state are carried on the snapshot", () => {
  const session = createSession();

  session.apply({ type: "busy_changed", busy: true });
  session.apply({ type: "usage_changed", totalTokens: 120, totalCost: 0.0042 });

  const snapshot = session.snapshot();
  assert.equal(snapshot.busy, true);
  assert.equal(snapshot.totalTokens, 120);
  assert.equal(snapshot.totalCost, 0.0042);
});

test("a snapshot is a copy; editing it does not affect the ledger", () => {
  const session = createSession();
  session.apply({ type: "message_added", messageId: "m1", role: "user" });

  const snapshot = session.snapshot();
  snapshot.entries.length = 0;

  assert.equal(session.snapshot().entries.length, 1);
});

test("a ledger can be rebuilt from a snapshot", () => {
  // The client side holds a mirror: start from the server's snapshot, then follow the actions.
  const origin = createSession();
  origin.apply({ type: "message_added", messageId: "m1", role: "user" });
  origin.apply({ type: "text_appended", messageId: "m1", text: "hello" });
  origin.apply({ type: "usage_changed", totalTokens: 120, totalCost: 0.004 });

  const mirror = createSession(origin.snapshot());

  assert.deepEqual(mirror.snapshot(), origin.snapshot());
});

test("a rebuilt ledger goes on accepting actions", () => {
  const origin = createSession();
  origin.apply({ type: "message_added", messageId: "m1", role: "assistant" });

  const mirror = createSession(origin.snapshot());
  mirror.apply({ type: "text_appended", messageId: "m1", text: "more" });

  assert.equal(mirror.snapshot().entries[0].text, "more");
});
