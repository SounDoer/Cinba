import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession, sameTranscript } from "./session.ts";

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

  session.apply({ type: "message_added", messageId: "m1", role: "assistant", stableId: false });
  session.apply({ type: "text_appended", messageId: "m1", text: "he" });
  session.apply({ type: "text_appended", messageId: "m1", text: "llo" });

  assert.deepEqual(session.snapshot().entries, [
    {
      kind: "message",
      messageId: "m1",
      stableId: false,
      role: "assistant",
      text: "hello",
      thinking: "",
    },
  ]);
});

test("thinking is stored separately from the body text", () => {
  const session = createSession();

  session.apply({ type: "message_added", messageId: "m1", role: "assistant", stableId: false });
  session.apply({ type: "thinking_appended", messageId: "m1", text: "thinking it over" });
  session.apply({ type: "text_appended", messageId: "m1", text: "the answer" });

  const entry = session.snapshot().entries[0];
  assert(entry?.kind === "message");
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

test("a confirm request moves the most recent active card to pending", () => {
  const session = createSession();

  session.apply({ type: "tool_changed", toolCallId: "a", toolName: "read", status: "done" });
  session.apply({ type: "tool_changed", toolCallId: "b", toolName: "bash", status: "running" });
  session.apply({ type: "confirm_requested", requestId: "u1" });

  const entries = session.snapshot().entries;
  assert(entries[0]?.kind === "tool");
  assert(entries[1]?.kind === "tool");
  assert.equal(entries[0].confirmRequestId, undefined, "a finished card must not have a confirmation attached");
  assert.equal(entries[1].confirmRequestId, "u1");
  assert.equal(entries[1].status, "pending");
});

test("answering a confirmation clears the pending marker on the card", () => {
  const session = createSession();

  session.apply({ type: "tool_changed", toolCallId: "b", toolName: "bash", status: "pending" });
  session.apply({ type: "confirm_requested", requestId: "u1" });
  session.apply({ type: "tool_changed", toolCallId: "b", toolName: "bash", status: "running" });

  const entry = session.snapshot().entries[0];
  assert(entry?.kind === "tool");
  assert.equal(entry.confirmRequestId, undefined);
  assert.equal(entry.status, "running");
});

test("a system notice enters the ledger as its own entry", () => {
  // A notice like "aborted" has to enter the ledger rather than just being
  // printed to the screen. Otherwise a GUI reload loses it and the user thinks
  // nothing ever happened.
  const session = createSession();

  session.apply({ type: "message_added", messageId: "m1", role: "assistant", stableId: false });
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
  session.apply({ type: "message_added", messageId: "m1", role: "user", stableId: false });

  const snapshot = session.snapshot();
  snapshot.entries.length = 0;

  assert.equal(session.snapshot().entries.length, 1);
});

test("a ledger can be rebuilt from a snapshot", () => {
  // The client side holds a mirror: start from the server's snapshot, then follow the actions.
  const origin = createSession();
  origin.apply({ type: "message_added", messageId: "m1", role: "user", stableId: false });
  origin.apply({ type: "text_appended", messageId: "m1", text: "hello" });
  origin.apply({ type: "usage_changed", totalTokens: 120, totalCost: 0.004 });

  const mirror = createSession(origin.snapshot());

  assert.deepEqual(mirror.snapshot(), origin.snapshot());
});

test("a rebuilt ledger goes on accepting actions", () => {
  const origin = createSession();
  origin.apply({ type: "message_added", messageId: "m1", role: "assistant", stableId: false });

  const mirror = createSession(origin.snapshot());
  mirror.apply({ type: "text_appended", messageId: "m1", text: "more" });

  const entry = mirror.snapshot().entries[0];
  assert(entry?.kind === "message");
  assert.equal(entry.text, "more");
});

test("two tellings of the same conversation match despite different ids", () => {
  // What the live path produces: ids this project made up while streaming.
  const live = createSession();
  live.apply({ type: "message_added", messageId: "m1", role: "user", stableId: false });
  live.apply({ type: "text_appended", messageId: "m1", text: "hi" });
  live.apply({ type: "message_added", messageId: "m2", role: "assistant", stableId: false });
  live.apply({ type: "text_appended", messageId: "m2", text: "hello" });
  live.apply({ type: "notice", text: "aborted" });

  // What a rebuild from Pi's file produces: Pi's own ids. Written out rather
  // than folded, because the contract must not depend on the agent to be tested.
  const rebuilt = createSession();
  rebuilt.apply({ type: "message_added", messageId: "x9", role: "user", stableId: true });
  rebuilt.apply({ type: "text_appended", messageId: "x9", text: "hi" });
  rebuilt.apply({ type: "message_added", messageId: "y8", role: "assistant", stableId: true });
  rebuilt.apply({ type: "text_appended", messageId: "y8", text: "hello" });

  assert.equal(sameTranscript(live.snapshot().entries, rebuilt.snapshot().entries), true);
});

test("a difference in what was actually said is caught", () => {
  const one = createSession();
  one.apply({ type: "message_added", messageId: "m1", role: "assistant", stableId: false });
  one.apply({ type: "text_appended", messageId: "m1", text: "the answer is 42" });

  const other = createSession();
  other.apply({ type: "message_added", messageId: "z1", role: "assistant", stableId: true });
  other.apply({ type: "text_appended", messageId: "z1", text: "the answer is 43" });

  assert.equal(sameTranscript(one.snapshot().entries, other.snapshot().entries), false);
});

test("a missing tool card counts as a difference", () => {
  const withTool = createSession();
  withTool.apply({ type: "tool_changed", toolCallId: "c1", toolName: "bash", status: "done" });

  assert.equal(sameTranscript(withTool.snapshot().entries, []), false);
});

test("separator characters in content cannot hide a transcript difference", () => {
  const left = createSession();
  left.apply({ type: "message_added", messageId: "left", role: "assistant", stableId: false });
  left.apply({ type: "text_appended", messageId: "left", text: "a|b" });
  left.apply({ type: "thinking_appended", messageId: "left", text: "c" });

  const right = createSession();
  right.apply({ type: "message_added", messageId: "right", role: "assistant", stableId: true });
  right.apply({ type: "text_appended", messageId: "right", text: "a" });
  right.apply({ type: "thinking_appended", messageId: "right", text: "b|c" });

  assert.equal(sameTranscript(left.snapshot().entries, right.snapshot().entries), false);
});
