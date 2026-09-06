import { test } from "node:test";
import assert from "node:assert/strict";
import { CoreClient } from "./client.ts";
import type { Transport } from "./transport.ts";

/** 假的传输层，用来在不启动 Pi 的情况下测协议逻辑。 */
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

test("prompt 发出带 id 的命令，收到回执后 resolve", async () => {
  const fake = createFakeTransport();
  const client = new CoreClient(fake.transport);

  const pending = client.prompt("你好");

  assert.equal(fake.sent.length, 1);
  const command = JSON.parse(fake.sent[0]!);
  assert.equal(command.type, "prompt");
  assert.equal(command.message, "你好");
  assert.ok(command.id, "命令必须带 id 才能配对回执");

  fake.receive({
    type: "response",
    command: "prompt",
    id: command.id,
    success: true,
  });

  const response = await pending;
  assert.equal(response.success, true);
});

test("事件被分发给订阅者", () => {
  const fake = createFakeTransport();
  const client = new CoreClient(fake.transport);

  const seen: string[] = [];
  client.onEvent((event) => seen.push(event.type));

  fake.receive({ type: "agent_start" });
  fake.receive({ type: "agent_settled" });

  assert.deepEqual(seen, ["agent_start", "agent_settled"]);
});

test("阻塞式 UI 请求交给处理器，并把结果按 id 回传", async () => {
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
    title: "执行 bash？",
  });

  // 等处理器这一轮微任务跑完
  await new Promise((resolve) => setImmediate(resolve));

  const reply = JSON.parse(fake.sent.at(-1)!);
  assert.equal(reply.type, "extension_ui_response");
  assert.equal(reply.id, "uuid-1");
  assert.equal(reply.confirmed, true);
});

test("广播式 UI 请求不回传任何东西", async () => {
  const fake = createFakeTransport();
  const client = new CoreClient(fake.transport);

  client.onUiRequest(async () => ({ confirmed: true }));

  fake.receive({
    type: "extension_ui_request",
    id: "uuid-2",
    method: "notify",
    message: "干活呢",
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fake.sent.length, 0, "notify 是广播式的，不该回话");
});
