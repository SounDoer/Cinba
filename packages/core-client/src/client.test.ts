import { test } from "node:test";
import assert from "node:assert/strict";
import { CoreClient } from "./client.ts";
import type { Transport } from "./transport.ts";

/** A fake transport, for testing protocol logic without starting Pi. */
function createFakeTransport(): {
  transport: Transport;
  sent: string[];
  receive: (obj: unknown) => void;
} {
  const sent: string[] = [];
  let handler: ((line: string) => void) | undefined;

  return {
    sent,
    receive: (obj) => handler?.(JSON.stringify(obj)),
    transport: {
      send: (line) => sent.push(line),
      onLine: (h) => {
        handler = h;
      },
      close: async () => {},
    },
  };
}

test("prompt sends a command with an id and resolves once the reply arrives", async () => {
  const fake = createFakeTransport();
  const client = new CoreClient(fake.transport);

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

test("events are fanned out to subscribers", () => {
  const fake = createFakeTransport();
  const client = new CoreClient(fake.transport);

  const seen: string[] = [];
  client.onEvent((event) => seen.push(event.type));

  fake.receive({ type: "agent_start" });
  fake.receive({ type: "agent_settled" });

  assert.deepEqual(seen, ["agent_start", "agent_settled"]);
});

test("a blocking UI request goes to the handler and the answer is written back under its id", async () => {
  const fake = createFakeTransport();
  const client = new CoreClient(fake.transport);

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

test("a broadcast UI request writes nothing back", async () => {
  const fake = createFakeTransport();
  const client = new CoreClient(fake.transport);

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
