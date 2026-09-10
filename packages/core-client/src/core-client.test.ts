import { test } from "node:test";
import assert from "node:assert/strict";
import { CoreClient } from "./core-client.ts";
import type { CoreClientHandlers, Socket } from "./core-client.ts";

/** A fake connection, for testing protocol logic without starting a server. */
function createFakeSocket(): {
  socket: Socket;
  sent: string[];
  closeCount: () => number;
  open: () => void;
  receive: (obj: unknown) => void;
  fail: (error: unknown) => void;
  disconnect: () => void;
} {
  const sent: string[] = [];
  let closes = 0;
  const socket: Socket = {
    send: (data) => sent.push(data),
    close: () => {
      closes++;
    },
    onmessage: null,
    onopen: null,
    onerror: null,
    onclose: null,
  };
  return {
    socket,
    sent,
    closeCount: () => closes,
    open: () => socket.onopen?.({}),
    receive: (obj) => socket.onmessage?.({ data: JSON.stringify(obj) }),
    fail: (error) => socket.onerror?.(error),
    disconnect: () => socket.onclose?.({}),
  };
}

const TEST_URL = "ws://core.test/ws";

function connect(fake: ReturnType<typeof createFakeSocket>, handlers: CoreClientHandlers): CoreClient {
  const client = new CoreClient(TEST_URL, handlers, {
    socketFactory: (url) => {
      assert.equal(url, TEST_URL);
      return fake.socket;
    },
  });
  fake.open();
  return client;
}

test("owns the socket lifecycle and rejects sends outside an open connection", () => {
  const fake = createFakeSocket();
  const states: string[] = [];
  const errors: unknown[] = [];
  const client = new CoreClient(TEST_URL, {
    onConnectionChanged: (state) => states.push(state),
    onError: (error) => errors.push(error),
  }, { socketFactory: () => fake.socket });

  assert.equal(client.connectionState, "connecting");
  assert.equal(client.prompt("too soon"), false);
  assert.deepEqual(fake.sent, []);

  fake.open();
  assert.equal(client.connectionState, "connected");
  assert.equal(client.prompt("hello"), true);

  const failure = new Error("network failed");
  fake.fail(failure);
  assert.deepEqual(errors, [failure]);

  fake.disconnect();
  assert.equal(client.connectionState, "disconnected");
  assert.equal(client.prompt("too late"), false);
  assert.deepEqual(states, ["connecting", "connected", "disconnected"]);
});

test("close is idempotent and detaches the socket", () => {
  const fake = createFakeSocket();
  const states: string[] = [];
  const client = connect(fake, { onConnectionChanged: (state) => states.push(state) });

  client.close();
  client.close();

  assert.equal(fake.closeCount(), 1);
  assert.equal(client.connectionState, "disconnected");
  assert.equal(fake.socket.onmessage, null);
  assert.deepEqual(states, ["connecting", "connected", "disconnected"]);
});

test("the conversation commands go out in protocol form", () => {
  const fake = createFakeSocket();
  const client = connect(fake, {});

  client.prompt("hello");
  client.abort();
  client.respondConfirm("u1", false);

  assert.deepEqual(
    fake.sent.map((line) => JSON.parse(line)),
    [
      { type: "prompt", text: "hello" },
      { type: "abort" },
      { type: "respond_confirm", requestId: "u1", confirmed: false },
    ],
  );
});

test("listDir goes out in protocol form and the listing reaches the handler", () => {
  const fake = createFakeSocket();
  const listings: unknown[] = [];

  const client = connect(fake, {
    onDirListing: (listing) => listings.push(listing),
  });

  client.listDir("C:\\Users");
  assert.deepEqual(JSON.parse(fake.sent[0]!), { type: "list_dir", path: "C:\\Users" });

  fake.receive({
    type: "dir_listing",
    path: "C:\\Users",
    parent: "C:\\",
    dirs: ["shenxichen", "Public"],
  });

  assert.deepEqual(listings, [
    { path: "C:\\Users", parent: "C:\\", dirs: ["shenxichen", "Public"] },
  ]);
});

test("snapshots and actions reach their respective handlers", () => {
  const fake = createFakeSocket();
  const snapshots: unknown[] = [];
  const batches: unknown[] = [];

  connect(fake, {
    onSnapshot: (state) => snapshots.push([state.snapshot, state.cwd]),
    onActions: (actions) => batches.push(actions),
  });

  const snapshot = { entries: [], totalTokens: 0, totalCost: 0, busy: false };
  fake.receive({ type: "snapshot", snapshot, cwd: "/home/me", sessionId: "s1" });
  fake.receive({ type: "actions", actions: [{ type: "busy_changed", busy: true }] });

  assert.deepEqual(snapshots, [[snapshot, "/home/me"]]);
  assert.deepEqual(batches, [[{ type: "busy_changed", busy: true }]]);
});

test("malformed messages are ignored rather than crashing", () => {
  const fake = createFakeSocket();
  connect(fake, { onActions: () => assert.fail("must not be called") });

  fake.socket.onmessage?.({ data: "this is not JSON" });
  fake.socket.onmessage?.({ data: 42 });
  fake.receive({ type: "never heard of this type" });
  fake.receive({ type: "actions", actions: "not an array" });
});

test("the model commands go out, and both model messages reach their handlers", () => {
  const fake = createFakeSocket();
  const seen: unknown[] = [];
  const client = connect(fake, {
    onModelListing: (models) => seen.push(models),
    onModelChanged: (model) => seen.push(model),
  });

  client.listModels();
  client.setModel("deepseek", "deepseek-v4-pro");

  assert.deepEqual(
    fake.sent.map((line) => JSON.parse(line)),
    [
      { type: "list_models" },
      { type: "set_model", provider: "deepseek", modelId: "deepseek-v4-pro" },
    ],
  );

  fake.receive({ type: "model_listing", models: [{ provider: "deepseek", id: "a" }] });
  fake.receive({ type: "model_changed", model: { provider: "deepseek", id: "a" } });

  assert.deepEqual(seen, [
    [{ provider: "deepseek", id: "a" }],
    { provider: "deepseek", id: "a" },
  ]);
});

test("a snapshot carries the current model alongside the working directory", () => {
  const fake = createFakeSocket();
  let got: unknown;
  const client = connect(fake, {
    onSnapshot: (state) => {
      got = { cwd: state.cwd, model: state.model, sessionId: state.sessionId };
    },
  });
  void client;

  fake.receive({
    type: "snapshot",
    snapshot: { entries: [], totalTokens: 0, totalCost: 0, busy: false },
    cwd: "/tmp",
    sessionId: "s1",
    model: { provider: "deepseek", id: "deepseek-v4-pro" },
  });

  assert.deepEqual(got, {
    cwd: "/tmp",
    sessionId: "s1",
    model: { provider: "deepseek", id: "deepseek-v4-pro" },
  });
});

test("the session commands go out, and both session messages reach their handlers", () => {
  const fake = createFakeSocket();
  const seen: unknown[] = [];
  const client = connect(fake, {
    onSessionListing: (sessions) => seen.push(sessions),
    onSessionOpened: (id) => seen.push(id),
  });

  client.listSessions();
  client.listSessions("C:/p");
  client.openSession("s1");
  client.createSession("C:/p");
  client.deleteSession("s2");

  assert.deepEqual(
    fake.sent.map((line) => JSON.parse(line)),
    [
      { type: "list_sessions" },
      { type: "list_sessions", cwd: "C:/p" },
      { type: "open_session", sessionId: "s1" },
      { type: "create_session", cwd: "C:/p" },
      { type: "delete_session", sessionId: "s2" },
    ],
  );

  fake.receive({
    type: "session_listing",
    sessions: [
      {
        id: "s1",
        cwd: "C:/p",
        messageCount: 1,
        firstMessage: "hello",
        modified: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  fake.receive({ type: "session_opened", sessionId: "s1" });

  assert.deepEqual(seen, [
    [
      {
        id: "s1",
        cwd: "C:/p",
        messageCount: 1,
        firstMessage: "hello",
        modified: "2026-01-01T00:00:00.000Z",
      },
    ],
    "s1",
  ]);
});
