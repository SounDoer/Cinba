import { test } from "node:test";
import assert from "node:assert/strict";
import gate from "./permission-gate.ts";

type ToolCallEvent = { toolName: string; input: unknown };
type Ctx = {
  cwd: string;
  hasUI: boolean;
  ui: { confirm: (title: string, message: string) => Promise<boolean> };
};
type Handler = (event: ToolCallEvent, ctx: Ctx) => Promise<unknown>;

/** Install a fake pi so the tool_call handler the gate registers can be called on its own. */
function captureHandler(): Handler {
  let handler: Handler | undefined;
  const pi = {
    on(name: string, fn: Handler) {
      if (name === "tool_call") handler = fn;
    },
  };
  (gate as (api: unknown) => void)(pi);
  if (!handler) throw new Error("the permission gate registered no tool_call handler");
  return handler;
}

/** Build a context. An undefined answer means the user must not be asked at all. */
function makeCtx(hasUI: boolean, answer?: boolean): Ctx {
  return {
    cwd: process.cwd(),
    hasUI,
    ui: {
      confirm: async () => {
        if (answer === undefined) throw new Error("the user must not be asked");
        return answer;
      },
    },
  };
}

test("blocks when there is no UI, rather than allowing", async () => {
  // A safety gate must fail closed: when the responsible party cannot be
  // reached the default is to refuse, not to allow. hasUI is always true in
  // RPC mode today, but if the agent package is ever used for headless automation,
  // failing open would let every tool pass silently — with no error either.
  const handler = captureHandler();

  const result = await handler(
    { toolName: "bash", input: { command: "git reset --hard" } },
    makeCtx(false),
  );

  assert.deepEqual(result, {
    block: true,
    reason: "No UI available to confirm, so blocked by default",
  });
});

test("a catastrophic command is blocked without asking", async () => {
  const handler = captureHandler();

  const result = await handler(
    { toolName: "powershell", input: { command: "Clear-Disk -Number 0 -RemoveData" } },
    makeCtx(true),
  );

  assert.deepEqual(result, {
    block: true,
    reason: 'Disk-destructive command "clear-disk" is blocked',
  });
});

test("read-only tools still pass when there is no UI", async () => {
  // Read-only tools carry no risk, and blocking them would make headless use impossible.
  const handler = captureHandler();

  const result = await handler({ toolName: "read", input: { path: "a.txt" } }, makeCtx(false));

  assert.equal(result, undefined);
});

test("read-only tools do not interrupt the user", async () => {
  const handler = captureHandler();

  const tools = [
    { toolName: "read", input: { path: "README.md" } },
    { toolName: "grep", input: { pattern: "hello" } },
    { toolName: "find", input: { pattern: "*.ts" } },
    { toolName: "ls", input: {} },
  ];
  for (const { toolName, input } of tools) {
    const result = await handler({ toolName, input }, makeCtx(true));
    assert.equal(result, undefined, `${toolName} must not be blocked`);
  }
});

test("ordinary workspace writes and shell commands do not interrupt the user", async () => {
  const handler = captureHandler();
  const context = makeCtx(true);

  assert.equal(
    await handler({ toolName: "write", input: { path: "src/new-file.ts", content: "" } }, context),
    undefined,
  );
  assert.equal(
    await handler({ toolName: "powershell", input: { command: "npm test" } }, context),
    undefined,
  );
});

test("an approval lets an Ask decision through", async () => {
  const handler = captureHandler();

  const result = await handler(
    { toolName: "bash", input: { command: "git reset --hard" } },
    makeCtx(true, true),
  );

  assert.equal(result, undefined);
});

test("a refusal blocks an Ask decision and hands the model a reason", async () => {
  const handler = captureHandler();

  const result = await handler(
    { toolName: "bash", input: { command: "git reset --hard" } },
    makeCtx(true, false),
  );

  assert.deepEqual(result, { block: true, reason: "The user denied this tool call" });
});
