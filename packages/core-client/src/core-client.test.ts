import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CoreClient,
  type CoreClientHandlers,
  type ReconnectScheduler,
  type Socket,
} from "./core-client.ts";

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
      closes += 1;
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

function createFakeScheduler(): ReconnectScheduler & {
  delays: number[];
  pendingCount: () => number;
  runNext: () => void;
} {
  const timers = new Map<object, () => void>();
  const delays: number[] = [];
  return {
    delays,
    setTimeout: (callback, delayMs) => {
      const handle = {};
      delays.push(delayMs);
      timers.set(handle, callback);
      return handle;
    },
    clearTimeout: (handle) => {
      if (typeof handle === "object" && handle !== null) {
        timers.delete(handle);
      }
    },
    pendingCount: () => timers.size,
    runNext: () => {
      const next = timers.entries().next().value as [object, () => void] | undefined;
      assert.ok(next, "expected a pending reconnect timer");
      timers.delete(next[0]);
      next[1]();
    },
  };
}

const TEST_URL = "ws://core.test/ws";

function connect(
  fake: ReturnType<typeof createFakeSocket>,
  handlers: CoreClientHandlers,
): CoreClient {
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
  const client = new CoreClient(
    TEST_URL,
    {
      onConnectionChanged: (state) => states.push(state),
      onError: (error) => errors.push(error),
    },
    { socketFactory: () => fake.socket },
  );

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

test("reconnects after the initial connection fails", () => {
  const scheduler = createFakeScheduler();
  const first = createFakeSocket();
  const second = createFakeSocket();
  const sockets = [first, second];
  const states: string[] = [];
  let attempts = 0;
  const client = new CoreClient(
    TEST_URL,
    { onConnectionChanged: (state) => states.push(state) },
    {
      autoReconnect: true,
      reconnectScheduler: scheduler,
      socketFactory: () => {
        const socket = sockets[attempts]!.socket;
        attempts += 1;
        return socket;
      },
    },
  );

  first.disconnect();
  assert.equal(client.connectionState, "disconnected");
  assert.deepEqual(scheduler.delays, [1_000]);

  scheduler.runNext();
  assert.equal(client.connectionState, "connecting");
  second.open();

  assert.equal(client.connectionState, "connected");
  assert.equal(attempts, 2);
  assert.deepEqual(states, ["connecting", "disconnected", "connecting", "connected"]);
});

test("reconnects after an established connection closes", () => {
  const scheduler = createFakeScheduler();
  const first = createFakeSocket();
  const second = createFakeSocket();
  const sockets = [first, second];
  let attempts = 0;
  const client = new CoreClient(
    TEST_URL,
    {},
    {
      autoReconnect: true,
      reconnectScheduler: scheduler,
      socketFactory: () => {
        const socket = sockets[attempts]!.socket;
        attempts += 1;
        return socket;
      },
    },
  );

  first.open();
  first.disconnect();
  scheduler.runNext();
  second.open();

  assert.equal(client.connectionState, "connected");
  assert.equal(attempts, 2);
});

test("backs off reconnect attempts up to thirty seconds", () => {
  const scheduler = createFakeScheduler();
  const errors: unknown[] = [];
  const client = new CoreClient(
    TEST_URL,
    { onError: (error) => errors.push(error) },
    {
      autoReconnect: true,
      reconnectScheduler: scheduler,
      socketFactory: () => {
        throw new Error("offline");
      },
    },
  );

  for (let index = 0; index < 6; index += 1) {
    scheduler.runNext();
  }

  assert.deepEqual(scheduler.delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  assert.equal(errors.length, 7);
  assert.equal(scheduler.pendingCount(), 1);
  client.close();
});

test("resets the reconnect delay after a successful connection", () => {
  const scheduler = createFakeScheduler();
  const connected = createFakeSocket();
  let attempts = 0;
  const client = new CoreClient(
    TEST_URL,
    {},
    {
      autoReconnect: true,
      reconnectScheduler: scheduler,
      socketFactory: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("offline");
        }
        return connected.socket;
      },
    },
  );

  scheduler.runNext();
  connected.open();
  connected.disconnect();

  assert.deepEqual(scheduler.delays, [1_000, 1_000]);
  client.close();
});

test("close cancels reconnect and prevents future sockets", () => {
  const scheduler = createFakeScheduler();
  const first = createFakeSocket();
  let attempts = 0;
  const client = new CoreClient(
    TEST_URL,
    {},
    {
      autoReconnect: true,
      reconnectScheduler: scheduler,
      socketFactory: () => {
        attempts += 1;
        return first.socket;
      },
    },
  );

  first.disconnect();
  assert.equal(scheduler.pendingCount(), 1);
  client.close();

  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(attempts, 1);
  assert.equal(first.closeCount(), 0);
});

test("maintains at most one socket and one reconnect timer", () => {
  const scheduler = createFakeScheduler();
  const first = createFakeSocket();
  const second = createFakeSocket();
  const sockets = [first, second];
  let attempts = 0;
  const client = new CoreClient(
    TEST_URL,
    {},
    {
      autoReconnect: true,
      reconnectScheduler: scheduler,
      socketFactory: () => {
        const socket = sockets[attempts]!.socket;
        attempts += 1;
        return socket;
      },
    },
  );

  first.disconnect();
  first.disconnect();
  assert.equal(scheduler.pendingCount(), 1);

  scheduler.runNext();
  assert.equal(attempts, 2);
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(first.socket.onopen, null);
  client.close();
});

test("does not replay commands after reconnecting", () => {
  const scheduler = createFakeScheduler();
  const first = createFakeSocket();
  const second = createFakeSocket();
  const sockets = [first, second];
  let attempts = 0;
  const client = new CoreClient(
    TEST_URL,
    {},
    {
      autoReconnect: true,
      reconnectScheduler: scheduler,
      socketFactory: () => {
        const socket = sockets[attempts]!.socket;
        attempts += 1;
        return socket;
      },
    },
  );

  first.open();
  client.prompt("run once");
  client.respondConfirm("request-1", true);
  first.disconnect();
  assert.equal(client.prompt("while offline"), false);
  scheduler.runNext();
  second.open();

  assert.equal(first.sent.length, 2);
  assert.deepEqual(second.sent, []);
});

test("the conversation commands go out in protocol form", () => {
  const fake = createFakeSocket();
  const client = connect(fake, {});

  client.prompt("hello");
  client.steer("change direction");
  client.followUp("then test");
  client.clearQueue();
  client.editMessage("entry-1", "fixed hello");
  client.abort();
  client.abortRetry();
  client.compact();
  client.respondConfirm("u1", false);

  assert.deepEqual(
    fake.sent.map((line) => JSON.parse(line)),
    [
      { type: "prompt", text: "hello" },
      { type: "prompt", text: "change direction", streamingBehavior: "steer" },
      { type: "prompt", text: "then test", streamingBehavior: "followUp" },
      { type: "clear_queue" },
      { type: "edit_message", entryId: "entry-1", text: "fixed hello" },
      { type: "abort" },
      { type: "abort_retry" },
      { type: "compact" },
      { type: "respond_confirm", requestId: "u1", confirmed: false },
    ],
  );
});

test("recovered drafts reach only their dedicated handler", () => {
  const fake = createFakeSocket();
  const recovered: unknown[] = [];
  connect(fake, { onDraftsRecovered: (drafts) => recovered.push(drafts) });

  fake.receive({
    type: "drafts_recovered",
    drafts: [
      { text: "change direction", behavior: "steer" },
      { text: "then test", behavior: "followUp" },
    ],
  });

  assert.deepEqual(recovered, [
    [
      { text: "change direction", behavior: "steer" },
      { text: "then test", behavior: "followUp" },
    ],
  ]);
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

  const snapshot = {
    entries: [],
    totalTokens: 0,
    totalCost: 0,
    busy: false,
    compacting: false,
    retry: null,
    context: { tokens: null, contextWindow: null, percent: null, estimated: false },
    thinking: { level: "off", available: ["off"] },
    queue: { steering: [], followUp: [] },
  };
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

  assert.deepEqual(seen, [[{ provider: "deepseek", id: "a" }], { provider: "deepseek", id: "a" }]);
});

test("thinking controls go out in protocol form", () => {
  const fake = createFakeSocket();
  const client = connect(fake, {});

  client.setThinkingLevel("high");
  client.cycleThinkingLevel();

  assert.deepEqual(
    fake.sent.map((line) => JSON.parse(line)),
    [{ type: "set_thinking_level", level: "high" }, { type: "cycle_thinking_level" }],
  );
});

test("web tools commands go out and sanitized status reaches its handler", () => {
  const fake = createFakeSocket();
  const statuses: unknown[] = [];
  const client = connect(fake, {
    onWebToolsStatus: (status) => statuses.push(status),
  });

  client.getWebToolsStatus();
  client.setWebToolsApiKey("exa", "secret");
  client.clearWebToolsApiKey("brave");
  client.setWebSearchPrimary("brave");

  assert.deepEqual(
    fake.sent.map((line) => JSON.parse(line)),
    [
      { type: "get_web_tools_status" },
      { type: "set_web_tools_api_key", providerId: "exa", apiKey: "secret" },
      { type: "clear_web_tools_api_key", providerId: "brave" },
      { type: "set_web_search_primary", primary: "brave" },
    ],
  );

  const status = {
    primary: "brave",
    effectiveOrder: ["brave", "exa", "duckduckgo"],
    providers: [
      {
        id: "brave",
        name: "Brave Search",
        available: true,
        source: "stored",
        hasStoredCredential: true,
        bestEffort: false,
      },
    ],
  };
  fake.receive({ type: "web_tools_status", status });

  assert.deepEqual(statuses, [status]);
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
