import { test } from "node:test";
import assert from "node:assert/strict";
import { PiClient } from "./pi-client.ts";
import type { Transport } from "./transport.ts";

/** A fake transport, for testing protocol logic without starting Pi. */
function createFakeTransport(): {
  transport: Transport;
  sent: string[];
  receive: (obj: unknown) => void;
  disconnect: (error?: Error) => void;
} {
  const sent: string[] = [];
  let handler: ((line: string) => void) | undefined;
  let closeHandler: ((error?: Error) => void) | undefined;

  return {
    sent,
    receive: (obj) => handler?.(JSON.stringify(obj)),
    disconnect: (error) => closeHandler?.(error),
    transport: {
      send: (line) => sent.push(line),
      onLine: (h) => {
        handler = h;
      },
      onClose: (h) => {
        closeHandler = h;
      },
      close: async () => closeHandler?.(),
    },
  };
}

test("prompt sends a command with an id and resolves once the reply arrives", async () => {
  const fake = createFakeTransport();
  const client = new PiClient(fake.transport);

  const pending = client.prompt("hello");

  assert.equal(fake.sent.length, 1);
  const command = JSON.parse(fake.sent[0]!);
  assert.equal(command.type, "prompt");
  assert.equal(command.message, "hello");
  assert.ok(command.id, "a command needs an id so the reply can be paired with it");

  fake.receive({
    type: "response",
    command: "prompt",
    id: command.id,
    success: true,
  });

  const response = await pending;
  assert.equal(response.success, true);
});

test("streaming prompts and queue clearing use Pi's RPC shapes", () => {
  const fake = createFakeTransport();
  const client = new PiClient(fake.transport);

  void client.prompt("change direction", "steer");
  void client.prompt("then summarize", "followUp");
  void client.clearQueue();

  const commands = fake.sent.map((line) => JSON.parse(line));
  assert.deepEqual(
    commands.map(({ id: _id, ...command }) => command),
    [
      { type: "prompt", message: "change direction", streamingBehavior: "steer" },
      { type: "prompt", message: "then summarize", streamingBehavior: "followUp" },
      { type: "clear_queue" },
    ],
  );
});

test("events are fanned out to subscribers", () => {
  const fake = createFakeTransport();
  const client = new PiClient(fake.transport);

  const seen: string[] = [];
  client.onEvent((event) => seen.push(event.type));

  fake.receive({ type: "agent_start" });
  fake.receive({ type: "agent_settled" });

  assert.deepEqual(seen, ["agent_start", "agent_settled"]);
});

test("valid JSON with the wrong shape is ignored", () => {
  const fake = createFakeTransport();
  const client = new PiClient(fake.transport);
  const seen: string[] = [];
  client.onEvent((event) => seen.push(event.type));

  fake.receive(null);
  fake.receive(42);
  fake.receive({ nope: "missing a type" });
  fake.receive({ type: "response", id: "1", success: "yes" });

  assert.deepEqual(seen, []);
});

test("disconnecting rejects pending and future commands", async () => {
  const fake = createFakeTransport();
  const client = new PiClient(fake.transport);
  const pending = client.getState();

  fake.disconnect(new Error("Pi went away"));

  await assert.rejects(pending, /Pi went away/);
  await assert.rejects(client.getState(), /Pi went away/);
});

test("a command that receives no response times out", async () => {
  const fake = createFakeTransport();
  const client = new PiClient(fake.transport, 5);

  await assert.rejects(client.getState(), /get_state timed out/);
});

test("a blocking UI request goes to the handler and the answer is written back under its id", async () => {
  const fake = createFakeTransport();
  const client = new PiClient(fake.transport);

  client.onUiRequest(async (request) => {
    assert.equal(request.method, "confirm");
    return { confirmed: true };
  });

  fake.receive({
    type: "extension_ui_request",
    id: "uuid-1",
    method: "confirm",
    title: "Run bash?",
  });

  // Let the handler's microtask round finish
  await new Promise((resolve) => setImmediate(resolve));

  const reply = JSON.parse(fake.sent.at(-1)!);
  assert.equal(reply.type, "extension_ui_response");
  assert.equal(reply.id, "uuid-1");
  assert.equal(reply.confirmed, true);
});

test("a failed UI handler safely cancels a blocking request", async () => {
  const fake = createFakeTransport();
  const client = new PiClient(fake.transport);
  client.onUiRequest(async () => {
    throw new Error("UI disappeared");
  });

  fake.receive({ type: "extension_ui_request", id: "uuid-failed", method: "confirm" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(fake.sent.at(-1)!), {
    type: "extension_ui_response",
    id: "uuid-failed",
    cancelled: true,
  });
});

test("a broadcast UI request writes nothing back", async () => {
  const fake = createFakeTransport();
  const client = new PiClient(fake.transport);

  client.onUiRequest(async () => ({ confirmed: true }));

  fake.receive({
    type: "extension_ui_request",
    id: "uuid-2",
    method: "notify",
    message: "working on it",
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fake.sent.length, 0, "notify is a broadcast and must not be answered");
});

test("the model commands go out in the shape Pi expects", async () => {
  const fake = createFakeTransport();
  const client = new PiClient(fake.transport);

  void client.getState();
  void client.getAvailableModels();
  void client.setModel("deepseek", "deepseek-v4-flash");

  const commands = fake.sent.map((line) => JSON.parse(line));
  assert.deepEqual(
    commands.map((command) => command.type),
    ["get_state", "get_available_models", "set_model"],
  );
  assert.equal(commands[2].provider, "deepseek");
  assert.equal(commands[2].modelId, "deepseek-v4-flash");

  // Every command needs its own id, or the replies cannot be told apart.
  const ids = new Set(commands.map((command) => command.id));
  assert.equal(ids.size, 3);
});

test("the thinking commands go out in the shape Pi expects", () => {
  const fake = createFakeTransport();
  const client = new PiClient(fake.transport);

  void client.getAvailableThinkingLevels();
  void client.setThinkingLevel("xhigh");
  void client.cycleThinkingLevel();

  assert.deepEqual(
    fake.sent.map((line) => {
      const { id: _id, ...command } = JSON.parse(line);
      return command;
    }),
    [
      { type: "get_available_thinking_levels" },
      { type: "set_thinking_level", level: "xhigh" },
      { type: "cycle_thinking_level" },
    ],
  );
});

test("the available command catalogue comes from Pi", () => {
  const fake = createFakeTransport();
  const client = new PiClient(fake.transport);

  void client.getCommands();

  const { id: _id, ...command } = JSON.parse(fake.sent[0]!);
  assert.deepEqual(command, { type: "get_commands" });
});

test("the session commands go out in the shape Pi expects", () => {
  const fake = createFakeTransport();
  const client = new PiClient(fake.transport);

  void client.getEntries();
  void client.getEntries("e42");
  void client.newSession();
  void client.switchSession("C:/sessions/a.jsonl");
  void client.setSessionName("refactor the parser");

  const commands = fake.sent.map((line) => JSON.parse(line));
  assert.deepEqual(
    commands.map((command) => command.type),
    ["get_entries", "get_entries", "new_session", "switch_session", "set_session_name"],
  );

  // Omitted rather than sent as undefined: Pi treats a present "since" as a
  // filter and errors when the id is unknown.
  assert.equal("since" in commands[0], false);
  assert.equal(commands[1].since, "e42");
  assert.equal(commands[3].sessionPath, "C:/sessions/a.jsonl");
  assert.equal(commands[4].name, "refactor the parser");
});

test("compaction and retry controls use Pi's dedicated RPC commands", () => {
  const fake = createFakeTransport();
  const client = new PiClient(fake.transport);

  void client.setAutoCompaction(false);
  void client.setAutoRetry(true);
  void client.abortRetry();
  void client.getSessionStats();
  void client.compact();

  assert.deepEqual(
    fake.sent.map((line) => {
      const { id: _id, ...command } = JSON.parse(line);
      return command;
    }),
    [
      { type: "set_auto_compaction", enabled: false },
      { type: "set_auto_retry", enabled: true },
      { type: "abort_retry" },
      { type: "get_session_stats" },
      { type: "compact" },
    ],
  );
});
