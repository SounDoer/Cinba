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

test("all four commands go out in protocol form", () => {
  const fake = createFakeSocket();
  const remote = new RemoteSession(fake.socket, {});

  remote.prompt("hello");
  remote.abort();
  remote.respondConfirm("u1", false);
  remote.setProject("/tmp");

  assert.deepEqual(
    fake.sent.map((line) => JSON.parse(line)),
    [
      { type: "prompt", text: "hello" },
      { type: "abort" },
      { type: "respond_confirm", requestId: "u1", confirmed: false },
      { type: "set_project", cwd: "/tmp" },
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
  const resets: string[] = [];

  new RemoteSession(fake.socket, {
    onSnapshot: (snapshot, cwd) => snapshots.push([snapshot, cwd]),
    onActions: (actions) => batches.push(actions),
    onReset: (cwd) => resets.push(cwd),
  });

  const snapshot = { entries: [], totalTokens: 0, totalCost: 0, busy: false };
  fake.receive({ type: "snapshot", snapshot, cwd: "/home/me" });
  fake.receive({ type: "actions", actions: [{ type: "busy_changed", busy: true }] });
  fake.receive({ type: "reset", cwd: "/tmp" });

  assert.deepEqual(snapshots, [[snapshot, "/home/me"]]);
  assert.deepEqual(batches, [[{ type: "busy_changed", busy: true }]]);
  assert.deepEqual(resets, ["/tmp"]);
});

test("malformed messages are ignored rather than crashing", () => {
  const fake = createFakeSocket();
  new RemoteSession(fake.socket, { onActions: () => assert.fail("must not be called") });

  fake.socket.onmessage?.({ data: "this is not JSON" });
  fake.socket.onmessage?.({ data: 42 });
  fake.receive({ type: "never heard of this type" });
});
