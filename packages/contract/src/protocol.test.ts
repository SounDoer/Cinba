import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClientMessage, parseServerMessage } from "./protocol.ts";

test("the basic client messages are recognized", () => {
  assert.deepEqual(parseClientMessage({ type: "prompt", text: "hello" }), {
    type: "prompt",
    text: "hello",
  });
  assert.deepEqual(parseClientMessage({ type: "abort" }), { type: "abort" });
  assert.deepEqual(
    parseClientMessage({ type: "edit_message", entryId: "entry-1", text: "fixed" }),
    { type: "edit_message", entryId: "entry-1", text: "fixed" },
  );
  assert.deepEqual(
    parseClientMessage({ type: "respond_confirm", requestId: "u1", confirmed: true }),
    { type: "respond_confirm", requestId: "u1", confirmed: true },
  );
});

test("server messages are validated before reaching a client", () => {
  const snapshot = {
    type: "snapshot",
    snapshot: { entries: [], totalTokens: 0, totalCost: 0, busy: false },
    cwd: "C:/work",
    sessionId: "s1",
  };
  const messages = [
    snapshot,
    {
      type: "actions",
      actions: [
        {
          type: "confirm_requested",
          requestId: "u1",
          title: "Allow bash?",
          message: "Rule: shell.delete",
        },
      ],
    },
    { type: "dir_listing", path: "C:/", parent: null, dirs: ["work"] },
    { type: "model_listing", models: [{ provider: "test", id: "model" }] },
    { type: "model_changed", model: { provider: "test", id: "model" } },
    {
      type: "session_listing",
      sessions: [
        {
          id: "s1",
          cwd: "C:/work",
          messageCount: 1,
          firstMessage: "hello",
          modified: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
    { type: "session_opened", sessionId: "s1" },
    { type: "provider_listing", providers: [{ id: "test", name: "Test", configured: true }] },
    { type: "core_identity", name: "home" },
  ];

  for (const message of messages) {
    assert.equal(parseServerMessage(message), message);
  }
});

test("malformed server messages are dropped", () => {
  assert.equal(parseServerMessage(null), undefined);
  assert.equal(parseServerMessage({ type: "actions", actions: "busy" }), undefined);
  assert.equal(
    parseServerMessage({ type: "actions", actions: [{ type: "busy_changed", busy: "yes" }] }),
    undefined,
  );
  assert.equal(
    parseServerMessage({
      type: "actions",
      actions: [{ type: "confirm_requested", requestId: "u1", message: 42 }],
    }),
    undefined,
  );
  assert.equal(
    parseServerMessage({
      type: "snapshot",
      snapshot: { entries: [], totalTokens: 0, totalCost: 0 },
      cwd: "C:/work",
      sessionId: "s1",
    }),
    undefined,
  );
  assert.equal(
    parseServerMessage({ type: "session_listing", sessions: [{ id: "s1" }] }),
    undefined,
  );
  assert.equal(parseServerMessage({ type: "never_heard_of_this" }), undefined);
});

test("list_dir is recognized", () => {
  assert.deepEqual(parseClientMessage({ type: "list_dir", path: "C:\\Users" }), {
    type: "list_dir",
    path: "C:\\Users",
  });
});

test("list_dir requires a non-empty string path", () => {
  assert.equal(parseClientMessage({ type: "list_dir" }), undefined);
  assert.equal(parseClientMessage({ type: "list_dir", path: "" }), undefined);
  assert.equal(parseClientMessage({ type: "list_dir", path: 42 }), undefined);
});

test("anything with a wrong field type is dropped", () => {
  // Anything off the network is untrusted. Better dropped than passed along with a wrong type.
  assert.equal(parseClientMessage({ type: "prompt", text: 123 }), undefined);
  assert.equal(parseClientMessage({ type: "respond_confirm", requestId: "u1" }), undefined);
  assert.equal(
    parseClientMessage({ type: "respond_confirm", requestId: 1, confirmed: true }),
    undefined,
  );
  assert.equal(parseClientMessage({ type: "create_session", cwd: "" }), undefined);
});

test("a blank prompt does not count", () => {
  assert.equal(parseClientMessage({ type: "prompt", text: "   " }), undefined);
});

test("edit_message requires a non-blank entry id and text", () => {
  assert.equal(parseClientMessage({ type: "edit_message", entryId: "", text: "fixed" }), undefined);
  assert.equal(parseClientMessage({ type: "edit_message", entryId: 1, text: "fixed" }), undefined);
  assert.equal(
    parseClientMessage({ type: "edit_message", entryId: "entry-1", text: "  " }),
    undefined,
  );
});

test("unknown input is dropped rather than crashing", () => {
  assert.equal(parseClientMessage({ type: "rm -rf /" }), undefined);
  assert.equal(parseClientMessage(null), undefined);
  assert.equal(parseClientMessage("prompt"), undefined);
  assert.equal(parseClientMessage(42), undefined);
});

test("the model messages parse, and a half-filled set_model does not", () => {
  assert.deepEqual(parseClientMessage({ type: "list_models" }), { type: "list_models" });
  assert.deepEqual(
    parseClientMessage({ type: "set_model", provider: "deepseek", modelId: "deepseek-v4-pro" }),
    { type: "set_model", provider: "deepseek", modelId: "deepseek-v4-pro" },
  );

  assert.equal(parseClientMessage({ type: "set_model", provider: "deepseek" }), undefined);
  assert.equal(parseClientMessage({ type: "set_model", provider: "", modelId: "x" }), undefined);
  assert.equal(parseClientMessage({ type: "set_model", provider: "x", modelId: 7 }), undefined);
});

test("the session messages parse, and bad ids are dropped", () => {
  assert.deepEqual(parseClientMessage({ type: "list_sessions" }), { type: "list_sessions" });
  assert.deepEqual(parseClientMessage({ type: "list_sessions", cwd: "C:/p" }), {
    type: "list_sessions",
    cwd: "C:/p",
  });
  assert.deepEqual(parseClientMessage({ type: "open_session", sessionId: "s1" }), {
    type: "open_session",
    sessionId: "s1",
  });
  assert.deepEqual(parseClientMessage({ type: "create_session", cwd: "C:/p" }), {
    type: "create_session",
    cwd: "C:/p",
  });
  assert.deepEqual(parseClientMessage({ type: "delete_session", sessionId: "s1" }), {
    type: "delete_session",
    sessionId: "s1",
  });

  // delete acts on a file, so a malformed id must never reach the handler.
  assert.equal(parseClientMessage({ type: "delete_session", sessionId: "" }), undefined);
  assert.equal(parseClientMessage({ type: "delete_session", sessionId: 7 }), undefined);
  assert.equal(parseClientMessage({ type: "open_session" }), undefined);
  assert.equal(parseClientMessage({ type: "create_session", cwd: "" }), undefined);
  assert.equal(parseClientMessage({ type: "list_sessions", cwd: 7 }), undefined);
});
