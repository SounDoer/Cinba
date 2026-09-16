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
  model: { provider: string; id: string } | undefined = { provider: "test", id: "model-1" };
  thinkingLevel = "medium";
  thinkingLevels = ["off", "low", "medium", "high"];
  responses = new Map<string, { success: boolean; error?: unknown }>();
  queue = { steering: [] as string[], followUp: [] as string[] };
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } = {
    tokens: 32_000,
    contextWindow: 128_000,
    percent: 25,
  };
  compactResult = { tokensBefore: 32_000, estimatedTokensAfter: 12_000 };
  slashCommands: unknown[] = [];
  sessionId = "session-1";

  send(line: string): void {
    const command = JSON.parse(line) as {
      id: string;
      type: string;
      since?: string;
      message?: string;
      level?: string;
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
      data = {
        sessionId: this.sessionId,
        thinkingLevel: this.thinkingLevel,
        ...(this.model ? { model: this.model } : {}),
      };
    } else if (command.type === "get_entries") {
      data = { entries, leafId: this.leafId };
    } else if (command.type === "get_available_models") {
      data = { models: [{ provider: "test", id: "model-2" }] };
    } else if (command.type === "get_available_thinking_levels") {
      data = { levels: this.thinkingLevels };
    } else if (command.type === "set_thinking_level" && command.level) {
      this.thinkingLevel = command.level;
    } else if (command.type === "cycle_thinking_level") {
      const index = this.thinkingLevels.indexOf(this.thinkingLevel);
      this.thinkingLevel = this.thinkingLevels[(index + 1) % this.thinkingLevels.length]!;
    } else if (command.type === "clear_queue") {
      data = this.queue;
      this.queue = { steering: [], followUp: [] };
    } else if (command.type === "get_session_stats") {
      data = { contextUsage: this.contextUsage };
    } else if (command.type === "compact") {
      data = this.compactResult;
    } else if (command.type === "get_commands") {
      data = { commands: this.slashCommands };
    }
    queueMicrotask(() => {
      const response = this.responses.get(command.type);
      this.#onLine(
        JSON.stringify({
          type: "response",
          command: command.type,
          id: command.id,
          success: response?.success ?? true,
          ...(response?.error === undefined ? {} : { error: response.error }),
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

  fail(error: Error): void {
    this.#onClose(error);
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

test("credential rotation affects only subsequently launched Pi processes", async (context) => {
  const cwd = mkdtempSync(join(tmpdir(), "cinba-registry-"));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  const first = new FakeTransport();
  const second = new FakeTransport();
  second.sessionId = "session-2";
  let credential = "first-key";
  let modelId = "model-one";
  const launches: Array<{ providerCredential?: string; model?: { id: string } }> = [];
  const transports = [first, second];
  const registry = createSessionRegistry({
    defaultModel: () => ({ provider: "test", id: modelId }),
    resolveProviderCredential: async () => credential,
    onActions: () => {},
    onSnapshot: () => {},
    launchPi: (options) => {
      launches.push(options);
      return {
        pi: new PiClient(transports.shift()!),
        failed: new Promise<undefined>(() => {}),
      };
    },
  });
  context.after(() => registry.closeAll());

  await registry.open({ cwd });
  credential = "second-key";
  modelId = "model-two";
  assert.equal(first.closed, false);
  await registry.open({ cwd });
  assert.deepEqual(
    launches.map((launch) => launch.providerCredential),
    ["first-key", "second-key"],
  );
  assert.deepEqual(
    launches.map((launch) => launch.model?.id),
    ["model-one", "model-two"],
  );
  assert.equal(first.closed, false);
});

test("open exposes Pi skills but not prompt or extension commands", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cinba-registry-"));
  const transport = new FakeTransport();
  transport.slashCommands = [
    {
      name: "skill:review",
      description: "Review the current change",
      source: "skill",
      sourceInfo: { scope: "project" },
    },
    {
      name: "deploy",
      description: "Deploy from a prompt",
      source: "prompt",
      sourceInfo: { scope: "project" },
    },
    {
      name: "cinba-edit-message",
      description: "Internal command",
      source: "extension",
      sourceInfo: { scope: "path" },
    },
  ];
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

    assert.deepEqual(opened?.skills, [
      {
        source: "skill",
        name: "skill:review",
        summary: "Review the current change",
        scope: "project",
      },
    ]);
  } finally {
    registry.closeAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an unexpectedly closed Pi is no longer returned as a live session", async () => {
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

    transport.fail(new Error("Pi process exited with code 1"));

    assert.equal(registry.get(opened.id), undefined);
    assert.equal(registry.size, 0);
  } finally {
    registry.closeAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an unexpectedly closed Pi reports the released session to its owner", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cinba-registry-"));
  const transport = new FakeTransport();
  const failures: Array<{ sessionId: string; message: string }> = [];
  const registry = createSessionRegistry({
    defaultModel: () => undefined,
    onActions: () => {},
    onSnapshot: () => {},
    onUnexpectedClose: (session, error) => {
      failures.push({ sessionId: session.id, message: error.message });
    },
    launchPi: () => ({
      pi: new PiClient(transport),
      failed: new Promise<undefined>(() => {}),
    }),
  });

  try {
    await registry.open({ cwd });

    transport.fail(new Error("Pi process exited with code 1"));

    assert.deepEqual(failures, [
      { sessionId: "session-1", message: "Pi process exited with code 1" },
    ]);
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
    await registry.abort(opened);
    assert.deepEqual(await registry.listModels(opened), [{ provider: "test", id: "model-2" }]);
    assert.equal(await registry.setModel(opened, { provider: "test", id: "model-2" }), true);
    assert.equal(await registry.rename(opened, "a useful name"), true);

    assert.deepEqual(
      transport.commands.map((command) => command.type),
      [
        "prompt",
        "clear_queue",
        "abort",
        "get_available_models",
        "set_model",
        "get_session_stats",
        "get_state",
        "get_available_thinking_levels",
        "set_session_name",
      ],
    );
    assert.equal(opened.model?.id, "model-2");
  } finally {
    registry.closeAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("opening sets Cinba's compaction and retry defaults and manual compaction updates context", async () => {
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
    assert.deepEqual(
      transport.commands.slice(0, 7).map(({ id: _id, ...command }) => command),
      [
        { type: "get_state" },
        { type: "set_auto_compaction", enabled: false },
        { type: "set_auto_retry", enabled: true },
        { type: "get_entries" },
        { type: "get_session_stats" },
        { type: "get_state" },
        { type: "get_available_thinking_levels" },
      ],
    );
    assert.deepEqual(opened.ledger.snapshot().context, {
      tokens: 32_000,
      contextWindow: 128_000,
      percent: 25,
      estimated: false,
    });
    assert.deepEqual(opened.ledger.snapshot().thinking, {
      level: "medium",
      available: ["off", "low", "medium", "high"],
    });

    transport.contextUsage = { tokens: null, contextWindow: 128_000, percent: null };
    const compacting = registry.compact(opened);
    registry.prompt(opened, "must not run during compaction");
    assert.equal(await compacting, true);
    assert.equal(
      transport.commands.some(
        (command) =>
          command.type === "prompt" && command.message === "must not run during compaction",
      ),
      false,
    );
    assert.deepEqual(opened.ledger.snapshot().context, {
      tokens: 12_000,
      contextWindow: 128_000,
      percent: 9.375,
      estimated: true,
    });
    assert.equal(opened.ledger.snapshot().compacting, false);
  } finally {
    registry.closeAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("thinking controls use the levels supported by the current model", async () => {
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

    assert.equal(await registry.setThinkingLevel(opened, "high"), true);
    assert.equal(opened.ledger.snapshot().thinking.level, "high");
    assert.equal(await registry.cycleThinkingLevel(opened), true);
    assert.equal(opened.ledger.snapshot().thinking.level, "off");
  } finally {
    registry.closeAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a refused prompt explains the failure and clears busy", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cinba-registry-"));
  const transport = new FakeTransport();
  transport.responses.set("prompt", { success: false, error: "No model configured" });
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
    registry.prompt(opened, "hello");
    await new Promise((resolve) => setImmediate(resolve));

    const snapshot = opened.ledger.snapshot();
    assert.equal(snapshot.busy, false);
    assert.deepEqual(snapshot.entries, [
      { kind: "notice", text: "prompt failed: No model configured" },
    ]);
  } finally {
    registry.closeAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a rejected steering prompt keeps an already-running session busy", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cinba-registry-"));
  const transport = new FakeTransport();
  transport.responses.set("prompt", { success: false, error: "cannot queue command" });
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
    registry.emit(opened, [{ type: "busy_changed", busy: true }]);
    transport.commands = [];

    registry.prompt(opened, "change direction", "steer");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(opened.ledger.snapshot().busy, true);
    assert.equal(transport.commands[0]?.streamingBehavior, "steer");
  } finally {
    registry.closeAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a session without a model explains what is missing without becoming busy", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cinba-registry-"));
  const transport = new FakeTransport();
  transport.model = undefined;
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

    const snapshot = opened.ledger.snapshot();
    assert.equal(snapshot.busy, false);
    assert.deepEqual(snapshot.entries, [
      { kind: "notice", text: "No model configured. Add a provider key first." },
    ]);
    assert.deepEqual(transport.commands, []);
  } finally {
    registry.closeAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a successful abort clears busy even when Pi sends no settled event", async () => {
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
    registry.prompt(opened, "hello");
    await registry.abort(opened);
    await new Promise((resolve) => setImmediate(resolve));

    const snapshot = opened.ledger.snapshot();
    assert.equal(snapshot.busy, false);
    assert.deepEqual(snapshot.entries, [{ kind: "notice", text: "aborted" }]);
  } finally {
    registry.closeAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("abort clears both queues before stopping and returns typed recovered drafts", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cinba-registry-"));
  const transport = new FakeTransport();
  transport.queue = { steering: ["change direction"], followUp: ["then test"] };
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

    const drafts = await registry.abort(opened);

    assert.deepEqual(
      transport.commands.map((command) => command.type),
      ["clear_queue", "abort"],
    );
    assert.deepEqual(drafts, [
      { text: "change direction", behavior: "steer" },
      { text: "then test", behavior: "followUp" },
    ]);
  } finally {
    registry.closeAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stopping a retry preserves queued messages", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cinba-registry-"));
  const transport = new FakeTransport();
  transport.queue = { steering: ["change direction"], followUp: ["then test"] };
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
    registry.emit(opened, [
      {
        type: "retry_changed",
        retrying: true,
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2_000,
        retryAt: Date.now() + 2_000,
        errorMessage: "Network error",
      },
    ]);
    transport.commands = [];

    assert.equal(await registry.abortRetry(opened), true);
    assert.deepEqual(
      transport.commands.map((command) => command.type),
      ["abort_retry"],
    );
    assert.deepEqual(transport.queue, {
      steering: ["change direction"],
      followUp: ["then test"],
    });
  } finally {
    registry.closeAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("abort still stops and reports when queue clearing fails", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cinba-registry-"));
  const transport = new FakeTransport();
  transport.responses.set("clear_queue", { success: false, error: "queue unavailable" });
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

    await registry.abort(opened);

    assert.deepEqual(
      transport.commands.map((command) => command.type),
      ["clear_queue", "abort"],
    );
    assert.deepEqual(opened.ledger.snapshot().entries, [
      { kind: "notice", text: "queue clear failed: queue unavailable" },
      { kind: "notice", text: "aborted" },
    ]);
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
