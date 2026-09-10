import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteSession } from "./remote.ts";
import type { Socket } from "./remote.ts";

/** A fake connection, for testing protocol logic without starting a server. */
function createFakeSocket(): { socket: Socket; sent: string[]; receive: (obj: unknown) => void } {
  const sent: string[] = [];
  const socket: Socket = {
    send: (data) => sent.push(data),
    onmessage: null,
  };
  return {
    socket,
    sent,
    receive: (obj) => socket.onmessage?.({ data: JSON.stringify(obj) }),
  };
}

test("the conversation commands go out in protocol form", () => {
  const fake = createFakeSocket();
  const remote = new RemoteSession(fake.socket, {});

  remote.prompt("hello");
  remote.abort();
  remote.respondConfirm("u1", false);

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

  const remote = new RemoteSession(fake.socket, {
    onDirListing: (listing) => listings.push(listing),
  });

  remote.listDir("C:\\Users");
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

  new RemoteSession(fake.socket, {
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
  new RemoteSession(fake.socket, { onActions: () => assert.fail("must not be called") });

  fake.socket.onmessage?.({ data: "this is not JSON" });
  fake.socket.onmessage?.({ data: 42 });
  fake.receive({ type: "never heard of this type" });
  fake.receive({ type: "actions", actions: "not an array" });
});

test("the model commands go out, and both model messages reach their handlers", () => {
  const fake = createFakeSocket();
  const seen: unknown[] = [];
  const remote = new RemoteSession(fake.socket, {
    onModelListing: (models) => seen.push(models),
    onModelChanged: (model) => seen.push(model),
  });

  remote.listModels();
  remote.setModel("deepseek", "deepseek-v4-pro");

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
  const remote = new RemoteSession(fake.socket, {
    onSnapshot: (state) => {
      got = { cwd: state.cwd, model: state.model, sessionId: state.sessionId };
    },
  });
  void remote;

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
  const remote = new RemoteSession(fake.socket, {
    onSessionListing: (sessions) => seen.push(sessions),
    onSessionOpened: (id) => seen.push(id),
  });

  remote.listSessions();
  remote.listSessions("C:/p");
  remote.openSession("s1");
  remote.createSession("C:/p");
  remote.deleteSession("s2");

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
