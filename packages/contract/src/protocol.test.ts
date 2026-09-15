import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClientMessage, parseServerMessage } from "./protocol.ts";

test("the basic client messages are recognized", () => {
  assert.deepEqual(parseClientMessage({ type: "prompt", text: "hello" }), {
    type: "prompt",
    text: "hello",
  });
  assert.deepEqual(parseClientMessage({ type: "abort" }), { type: "abort" });
  assert.deepEqual(parseClientMessage({ type: "abort_retry" }), { type: "abort_retry" });
  assert.deepEqual(parseClientMessage({ type: "compact" }), { type: "compact" });
  assert.deepEqual(
    parseClientMessage({ type: "prompt", text: "change direction", streamingBehavior: "steer" }),
    { type: "prompt", text: "change direction", streamingBehavior: "steer" },
  );
  assert.deepEqual(parseClientMessage({ type: "clear_queue" }), { type: "clear_queue" });
  assert.deepEqual(
    parseClientMessage({ type: "edit_message", entryId: "entry-1", text: "fixed" }),
    { type: "edit_message", entryId: "entry-1", text: "fixed" },
  );
  assert.deepEqual(
    parseClientMessage({ type: "respond_confirm", requestId: "u1", confirmed: true }),
    { type: "respond_confirm", requestId: "u1", confirmed: true },
  );
  assert.deepEqual(
    parseClientMessage({ type: "respond_project_trust", requestId: "trust-1", trusted: true }),
    { type: "respond_project_trust", requestId: "trust-1", trusted: true },
  );
});

test("server messages are validated before reaching a client", () => {
  const snapshot = {
    type: "snapshot",
    snapshot: {
      entries: [],
      totalTokens: 0,
      totalCost: 0,
      busy: false,
      compacting: false,
      retry: null,
      context: { tokens: null, contextWindow: null, percent: null, estimated: false },
      thinking: { level: "off", available: ["off"] },
      queue: { steering: [], followUp: [] },
    },
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
    {
      type: "drafts_recovered",
      drafts: [{ text: "change direction", behavior: "steer" }],
    },
    {
      type: "skill_listing",
      sessionId: "s1",
      skills: [
        {
          source: "skill",
          name: "skill:tdd",
          summary: "work test-first",
          scope: "user",
        },
      ],
    },
    {
      type: "project_trust_requested",
      requestId: "trust-1",
      cwd: "C:/work",
      resources: [".agents/skills"],
    },
  ];

  for (const message of messages) {
    assert.equal(parseServerMessage(message), message);
  }
});

test("a new client supplies defaults when a persistent Core sends an older snapshot", () => {
  const parsed = parseServerMessage({
    type: "snapshot",
    snapshot: {
      entries: [],
      totalTokens: 12,
      totalCost: 0.01,
      busy: false,
      compacting: false,
      context: { tokens: 12, contextWindow: 1_000, percent: 1.2, estimated: false },
      queue: { steering: [], followUp: [] },
    },
    cwd: "C:/work",
    sessionId: "s1",
  });

  assert(parsed?.type === "snapshot");
  assert.equal(parsed.snapshot.retry, null);
  assert.deepEqual(parsed.snapshot.thinking, { level: "off", available: ["off"] });
  assert.equal(parsed.cwd, "C:/work");
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

test("retry actions validate every field", () => {
  const valid = {
    type: "actions",
    actions: [
      {
        type: "retry_changed",
        retrying: true,
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2_000,
        retryAt: 12_000,
        errorMessage: "Service overloaded",
      },
    ],
  };
  assert.equal(parseServerMessage(valid), valid);
  assert.equal(
    parseServerMessage({
      ...valid,
      actions: [{ ...valid.actions[0], retryAt: "soon" }],
    }),
    undefined,
  );
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
  assert.equal(
    parseClientMessage({ type: "prompt", text: "hello", streamingBehavior: "later" }),
    undefined,
  );
  assert.equal(parseClientMessage({ type: "respond_confirm", requestId: "u1" }), undefined);
  assert.equal(
    parseClientMessage({ type: "respond_project_trust", requestId: "u1", trusted: "yes" }),
    undefined,
  );
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

test("thinking controls accept only Pi's canonical levels", () => {
  assert.deepEqual(parseClientMessage({ type: "set_thinking_level", level: "high" }), {
    type: "set_thinking_level",
    level: "high",
  });
  assert.deepEqual(parseClientMessage({ type: "cycle_thinking_level" }), {
    type: "cycle_thinking_level",
  });
  assert.equal(parseClientMessage({ type: "set_thinking_level", level: "extreme" }), undefined);
  assert.equal(parseClientMessage({ type: "cycle_thinking_level", extra: true }), undefined);
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

test("web tools management messages accept only supported providers and primary choices", () => {
  const messages = [
    { type: "get_web_tools_status" },
    { type: "set_web_tools_api_key", providerId: "exa", apiKey: "secret" },
    { type: "clear_web_tools_api_key", providerId: "brave" },
    { type: "set_web_search_primary", primary: "auto" },
    { type: "set_web_search_primary", primary: "exa" },
    { type: "set_web_search_primary", primary: "brave" },
  ];

  for (const message of messages) {
    assert.deepEqual(parseClientMessage(message), message);
  }

  assert.equal(
    parseClientMessage({ type: "set_web_tools_api_key", providerId: "duckduckgo", apiKey: "x" }),
    undefined,
  );
  assert.equal(
    parseClientMessage({ type: "set_web_tools_api_key", providerId: "exa", apiKey: "  " }),
    undefined,
  );
  assert.equal(
    parseClientMessage({ type: "clear_web_tools_api_key", providerId: "duckduckgo" }),
    undefined,
  );
  assert.equal(
    parseClientMessage({ type: "set_web_search_primary", primary: "duckduckgo" }),
    undefined,
  );
  assert.equal(
    parseClientMessage({ type: "clear_web_tools_api_key", providerId: "exa", apiKey: "secret" }),
    undefined,
  );
});

test("web tools status is strictly validated and never carries credentials", () => {
  const message = {
    type: "web_tools_status",
    status: {
      primary: "auto",
      effectiveOrder: ["exa", "brave", "duckduckgo"],
      providers: [
        {
          id: "exa",
          name: "Exa",
          available: true,
          source: "stored",
          hasStoredCredential: true,
          bestEffort: false,
        },
        {
          id: "brave",
          name: "Brave Search",
          available: false,
          hasStoredCredential: false,
          bestEffort: false,
        },
        {
          id: "duckduckgo",
          name: "DuckDuckGo",
          available: true,
          hasStoredCredential: false,
          bestEffort: true,
        },
      ],
    },
  };

  assert.equal(parseServerMessage(message), message);
  const failed = { ...message, error: "Could not save the credential" };
  assert.equal(parseServerMessage(failed), failed);
  assert.equal(parseServerMessage({ ...message, error: 500 }), undefined);
  assert.equal(
    parseServerMessage({
      ...message,
      status: {
        ...message.status,
        providers: [{ ...message.status.providers[0], apiKey: "secret" }],
      },
    }),
    undefined,
  );
  assert.equal(
    parseServerMessage({ ...message, status: { ...message.status, effectiveOrder: ["google"] } }),
    undefined,
  );
});
