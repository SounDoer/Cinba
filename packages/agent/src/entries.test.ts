import { test } from "node:test";
import assert from "node:assert/strict";
import { activeBranchEntries, foldSessionEntries } from "./entries.ts";

test("activeBranchEntries follows the selected leaf and leaves abandoned branches out", () => {
  const entries = [
    { id: "u1", parentId: null, type: "message" },
    { id: "a1", parentId: "u1", type: "message" },
    { id: "u2-old", parentId: "a1", type: "message" },
    { id: "a2-old", parentId: "u2-old", type: "message" },
    { id: "u2-new", parentId: "a1", type: "message" },
    { id: "a2-new", parentId: "u2-new", type: "message" },
  ];

  assert.deepEqual(
    activeBranchEntries(entries, "a2-new").map((entry) => (entry as { id: string }).id),
    ["u1", "a1", "u2-new", "a2-new"],
  );
});
import { createSession } from "@cinba/contract";

/**
 * Shaped after real session files under
 * ~/.pi/agent/sessions/--<encoded cwd>--/*.jsonl, fields trimmed to the ones
 * this folder reads. The tool call here is a refused one, which is what a
 * denial through the permission gate actually looks like on disk.
 */
const STORED = [
  {
    type: "model_change",
    id: "a1",
    parentId: null,
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
  },
  { type: "thinking_level_change", id: "a2", parentId: "a1", thinkingLevel: "high" },
  {
    type: "message",
    id: "a3",
    message: { role: "user", content: [{ type: "text", text: "list the files" }] },
  },
  {
    type: "message",
    id: "a4",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "They want ls." },
        { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
      ],
      usage: { totalTokens: 2092, cost: { total: 0.001 } },
    },
  },
  {
    type: "message",
    id: "a5",
    message: {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      isError: true,
      content: [{ type: "text", text: "the user refused this tool call" }],
    },
  },
  {
    type: "message",
    id: "a6",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Understood, I will not run it." }],
      usage: { totalTokens: 2131, cost: { total: 0.002 } },
    },
  },
  { type: "model_change", id: "a7", provider: "deepseek", modelId: "deepseek-v4-flash" },
] as const;

test("a stored conversation folds back into a transcript", () => {
  const session = createSession();
  for (const action of foldSessionEntries(STORED as readonly unknown[])) session.apply(action);
  const snapshot = session.snapshot();

  assert.deepEqual(
    snapshot.entries.map((entry) => entry.kind),
    ["model", "message", "message", "tool", "message", "model"],
  );

  const [, question, answer, tool, closing] = snapshot.entries;
  assert.equal(question!.kind === "message" && question.text, "list the files");
  assert.equal(answer!.kind === "message" && answer.thinking, "They want ls.");
  assert.equal(closing!.kind === "message" && closing.text, "Understood, I will not run it.");

  // The refusal has to survive the round trip: a card that reads "done" would
  // tell the user a command ran when it did not.
  assert.equal(tool!.kind === "tool" && tool.status, "error");
  assert.equal(tool!.kind === "tool" && tool.result, "the user refused this tool call");
  assert.deepEqual(tool!.kind === "tool" && tool.args, { command: "ls" });
});

test("usage accumulates across the stored messages", () => {
  const session = createSession();
  for (const action of foldSessionEntries(STORED as readonly unknown[])) session.apply(action);
  const snapshot = session.snapshot();

  assert.equal(snapshot.totalTokens, 2092 + 2131);
  assert.equal(Math.round(snapshot.totalCost * 1000) / 1000, 0.003);
});

test("a tool call whose result was never stored stays pending", () => {
  // What an answer cut off mid-tool looks like on disk. Rendering it as done
  // would claim an outcome that never happened.
  const actions = foldSessionEntries([
    {
      type: "message",
      id: "b1",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_9", name: "bash", arguments: {} }],
      },
    },
  ]);

  const tool = actions.find((action) => action.type === "tool_changed");
  assert.equal(tool?.type === "tool_changed" && tool.status, "pending");
});

test("unknown and malformed entries are skipped, not fatal", () => {
  // Old sessions and future Pi versions both land here.
  const actions = foldSessionEntries([
    { type: "custom", id: "c1", customType: "something-else" },
    { type: "label", id: "c2", targetId: "c1", label: "x" },
    { type: "message", id: "c3" },
    { type: "message", id: "c4", message: { role: "assistant", content: "not an array" } },
    null,
    "nonsense",
    { type: "model_change", id: "c5", provider: "deepseek" },
  ]);

  assert.deepEqual(
    actions.map((action) => action.type),
    ["message_added"],
  );
});

test("a stored message without an id is skipped", () => {
  assert.deepEqual(
    foldSessionEntries([
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "orphan" }] },
      },
    ]),
    [],
  );
});

test("message ids come from Pi, so a rebuild lands on the same ids", () => {
  const actions = foldSessionEntries([
    {
      type: "message",
      id: "d1",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    },
  ]);

  assert.deepEqual(actions, [
    { type: "message_added", messageId: "d1", role: "user", stableId: true },
    { type: "text_appended", messageId: "d1", text: "hi" },
  ]);
});
