import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiClient } from "@cinba/agent";
import type { Transport } from "@cinba/agent";
import { createSessionRegistry } from "./session-registry.ts";

class FakeTransport implements Transport {
  #onLine: (line: string) => void = () => {};
  closed = false;
  commands: Array<Record<string, unknown>> = [];

  send(line: string): void {
    const command = JSON.parse(line) as { id: string; type: string };
    this.commands.push(command);
    const data =
      command.type === "get_state"
        ? { sessionId: "session-1", model: { provider: "test", id: "model-1" } }
        : command.type === "get_entries"
          ? { entries: [] }
          : command.type === "get_available_models"
            ? { models: [{ provider: "test", id: "model-2" }] }
          : undefined;
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

  emit(event: Record<string, unknown>): void {
    this.#onLine(JSON.stringify(event));
  }

  async close(): Promise<void> {
    this.closed = true;
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
