import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiClient, type Transport } from "@cinba/agent";
import { createSessionRegistry } from "./session-registry.ts";

class FakeTransport implements Transport {
  #onLine: (line: string) => void = () => {};
  #onClose: (error?: Error) => void = () => {};
  closed = false;
  commands: Array<Record<string, unknown>> = [];
  entries: Array<Record<string, unknown>> = [];
  leafId: string | null = null;

  send(line: string): void {
    const command = JSON.parse(line) as {
      id: string;
      type: string;
      since?: string;
      message?: string;
    };
    this.commands.push(command);
    if (command.type === "prompt" && command.message?.startsWith("/cinba-edit-message ")) {
      const targetId = command.message.slice("/cinba-edit-message ".length);
      const target = this.entries.find((entry) => entry.id === targetId);
      this.leafId = typeof target?.parentId === "string" ? target.parentId : null;
    }
    const sinceIndex = command.since
      ? this.entries.findIndex((entry) => entry.id === command.since)
      : -1;
    const entries = sinceIndex >= 0 ? this.entries.slice(sinceIndex + 1) : this.entries;
    let data: unknown;
    if (command.type === "get_state") {
      data = { sessionId: "session-1", model: { provider: "test", id: "model-1" } };
    } else if (command.type === "get_entries") {
      data = { entries, leafId: this.leafId };
    } else if (command.type === "get_available_models") {
      data = { models: [{ provider: "test", id: "model-2" }] };
    }
    queueMicrotask(() => {
      this.#onLine(
        JSON.stringify({
          type: "response",
          command: command.type,
          id: command.id,
          success: true,
          data,
        }),
      );
    });
  }

  onLine(callback: (line: string) => void): void {
    this.#onLine = callback;
  }

  onClose(callback: (error?: Error) => void): void {
    this.#onClose = callback;
  }

  emit(event: Record<string, unknown>): void {
    this.#onLine(JSON.stringify(event));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.#onClose();
  }
}

test("open owns a live session and stop releases its Pi", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cinba-registry-"));
  const transport = new FakeTransport();
  const registry = createSessionRegistry({
    defaultModel: () => undefined,
    onActions: () => {},
    onSnapshot: () => {},
    launchPi: () => ({
      pi: new PiClient(transport),
      failed: new Promise<undefined>(() => {}),
    }),
  });

  try {
    const opened = await registry.open({ cwd });

    assert.equal(opened?.id, "session-1");
    assert.equal(registry.get("session-1"), opened);
    assert.equal(registry.size, 1);

    registry.stop("session-1");
    assert.equal(registry.size, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(transport.closed, true);
  } finally {
    registry.closeAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Pi events update the ledger and arrive as one batched notification", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cinba-registry-"));
  const transport = new FakeTransport();
  const batches: unknown[][] = [];
  const registry = createSessionRegistry({
    defaultModel: () => undefined,
    onActions: (_sessionId, actions) => batches.push(actions),
    onSnapshot: () => {},
    launchPi: () => ({
      pi: new PiClient(transport),
      failed: new Promise<undefined>(() => {}),
    }),
    flushIntervalMs: 5,
  });

  try {
    const opened = await registry.open({ cwd });
    assert(opened);

    transport.emit({ type: "agent_start" });
    transport.emit({
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 15));

    assert.equal(opened.ledger.snapshot().busy, true);
    assert.equal(opened.ledger.snapshot().entries.length, 1);
    assert.equal(batches.length, 1);
    assert.equal(batches[0]?.length, 3);
  } finally {
    registry.closeAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("settling replaces streaming message ids with Pi entry ids", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cinba-registry-"));
  const transport = new FakeTransport();
  const snapshots: unknown[] = [];
  const registry = createSessionRegistry({
    defaultModel: () => undefined,
    onActions: () => {},
    onSnapshot: (_sessionId, snapshot) => snapshots.push(snapshot),
    launchPi: () => ({
      pi: new PiClient(transport),
      failed: new Promise<undefined>(() => {}),
    }),
  });

  try {
    const opened = await registry.open({ cwd });
    assert(opened);
    transport.emit({
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
    const streaming = opened.ledger.snapshot().entries[0];
    assert(streaming?.kind === "message");
    assert.equal(streaming.stableId, false);

    transport.entries = [
      {
        type: "message",
        id: "pi-user-1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      },
    ];
    transport.leafId = "pi-user-1";
    transport.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const persisted = opened.ledger.snapshot().entries[0];
    assert(persisted?.kind === "message");
    assert.equal(persisted.messageId, "pi-user-1");
    assert.equal(persisted.stableId, true);
    assert.equal(snapshots.length, 1);
  } finally {
    registry.closeAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("public session commands hide the Pi transport from callers", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cinba-registry-"));
  const transport = new FakeTransport();
  const registry = createSessionRegistry({
    defaultModel: () => undefined,
    onActions: () => {},
    onSnapshot: () => {},
    launchPi: () => ({
      pi: new PiClient(transport),
      failed: new Promise<undefined>(() => {}),
    }),
  });

  try {
    const opened = await registry.open({ cwd });
    assert(opened);
    transport.commands = [];

    registry.prompt(opened, "hello");
    registry.abort(opened);
    assert.deepEqual(await registry.listModels(opened), [{ provider: "test", id: "model-2" }]);
    assert.equal(await registry.setModel(opened, { provider: "test", id: "model-2" }), true);
    assert.equal(await registry.rename(opened, "a useful name"), true);

    assert.deepEqual(
      transport.commands.map((command) => command.type),
      ["prompt", "abort", "get_available_models", "set_model", "set_session_name"],
    );
    assert.equal(opened.model?.id, "model-2");
  } finally {
    registry.closeAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a confirmation is denied immediately when nobody is viewing the session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cinba-registry-"));
  const transport = new FakeTransport();
  const registry = createSessionRegistry({
    defaultModel: () => undefined,
    hasViewers: () => false,
    onActions: () => {},
    onSnapshot: () => {},
    launchPi: () => ({
      pi: new PiClient(transport),
      failed: new Promise<undefined>(() => {}),
    }),
  });

  try {
    const opened = await registry.open({ cwd });
    assert(opened);
    transport.commands = [];
    transport.emit({
      type: "extension_ui_request",
      id: "confirm-1",
      method: "confirm",
      title: "Allow deletion?",
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(transport.commands.at(-1), {
      type: "extension_ui_response",
      id: "confirm-1",
      confirmed: false,
    });
    assert.equal(opened.pendingConfirms.size, 0);
  } finally {
    registry.closeAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("pending confirmations are denied when the last viewer leaves", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cinba-registry-"));
  const transport = new FakeTransport();
  const registry = createSessionRegistry({
    defaultModel: () => undefined,
    hasViewers: () => true,
    onActions: () => {},
    onSnapshot: () => {},
    launchPi: () => ({
      pi: new PiClient(transport),
      failed: new Promise<undefined>(() => {}),
    }),
  });

  try {
    const opened = await registry.open({ cwd });
    assert(opened);
    transport.commands = [];
    transport.emit({
      type: "extension_ui_request",
      id: "confirm-2",
      method: "confirm",
      title: "Allow deletion?",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(opened.pendingConfirms.size, 1);

    registry.denyPendingConfirmations(opened);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(opened.pendingConfirms.size, 0);
    assert.deepEqual(transport.commands.at(-1), {
      type: "extension_ui_response",
      id: "confirm-2",
      confirmed: false,
    });
  } finally {
    registry.closeAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a confirmation timeout denies the request and expires its tool card", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cinba-registry-"));
  const transport = new FakeTransport();
  const registry = createSessionRegistry({
    defaultModel: () => undefined,
    hasViewers: () => true,
    onActions: () => {},
    onSnapshot: () => {},
    launchPi: () => ({
      pi: new PiClient(transport),
      failed: new Promise<undefined>(() => {}),
    }),
  });

  try {
    const opened = await registry.open({ cwd });
    assert(opened);
    transport.commands = [];
    transport.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "git reset --hard" },
    });
    transport.emit({
      type: "extension_ui_request",
      id: "confirm-timeout",
      method: "confirm",
      title: "Allow bash?",
      timeout: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(opened.pendingConfirms.size, 0);
    assert.deepEqual(transport.commands.at(-1), {
      type: "extension_ui_response",
      id: "confirm-timeout",
      confirmed: false,
    });
    const tool = opened.ledger
      .snapshot()
      .entries.find((entry) => entry.kind === "tool" && entry.toolCallId === "tool-1");
    assert.deepEqual(tool, {
      kind: "tool",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "git reset --hard" },
      status: "error",
      result: "Confirmation timed out.",
      confirmRequestId: undefined,
    });
  } finally {
    registry.closeAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("editing navigates in place before sending the replacement prompt", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cinba-registry-"));
  const transport = new FakeTransport();
  transport.entries = [
    {
      type: "message",
      id: "user-1",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      type: "message",
      id: "user-2",
      parentId: "user-1",
      message: { role: "user", content: [{ type: "text", text: "again" }] },
    },
  ];
  transport.leafId = "user-2";
  const registry = createSessionRegistry({
    defaultModel: () => undefined,
    onActions: () => {},
    onSnapshot: () => {},
    launchPi: () => ({
      pi: new PiClient(transport),
      failed: new Promise<undefined>(() => {}),
    }),
  });

  try {
    const opened = await registry.open({ cwd });
    assert(opened);
    transport.commands = [];

    assert.equal(await registry.editMessage(opened, "user-2", "fixed hello"), true);
    assert.deepEqual(
      transport.commands.map((command) => [command.type, command.message]),
      [
        ["get_entries", undefined],
        ["prompt", "/cinba-edit-message user-2"],
        ["get_entries", undefined],
        ["prompt", "fixed hello"],
      ],
    );
    assert.equal(registry.get("session-1"), opened, "the conversation id stays unchanged");
  } finally {
    registry.closeAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});
