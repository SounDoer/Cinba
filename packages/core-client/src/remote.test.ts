import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteSession } from "./remote.ts";
import type { Socket } from "./remote.ts";

/** 假的连接，用来在不起服务器的情况下测协议逻辑。 */
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

test("四种命令都按协议发出去", () => {
  const fake = createFakeSocket();
  const remote = new RemoteSession(fake.socket, {});

  remote.prompt("你好");
  remote.abort();
  remote.respondConfirm("u1", false);
  remote.setProject("/tmp");

  assert.deepEqual(
    fake.sent.map((line) => JSON.parse(line)),
    [
      { type: "prompt", text: "你好" },
      { type: "abort" },
      { type: "respond_confirm", requestId: "u1", confirmed: false },
      { type: "set_project", cwd: "/tmp" },
    ],
  );
});

test("快照与动作分别交给对应的处理器", () => {
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

test("坏消息被忽略，不崩", () => {
  const fake = createFakeSocket();
  new RemoteSession(fake.socket, { onActions: () => assert.fail("不该被调用") });

  fake.socket.onmessage?.({ data: "这不是 JSON" });
  fake.socket.onmessage?.({ data: 42 });
  fake.receive({ type: "没听过的类型" });
});
