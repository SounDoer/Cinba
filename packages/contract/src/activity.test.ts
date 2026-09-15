import { test } from "node:test";
import assert from "node:assert/strict";
import { agentActivity } from "./activity.ts";
import { createSession } from "./session.ts";

test("activity reports the most specific current phase", () => {
  const session = createSession();
  assert.deepEqual(agentActivity(session.snapshot()), { type: "idle" });

  session.apply({ type: "busy_changed", busy: true });
  assert.deepEqual(agentActivity(session.snapshot()), { type: "answering" });

  session.apply({ type: "tool_changed", toolCallId: "t1", toolName: "bash", status: "running" });
  assert.deepEqual(agentActivity(session.snapshot()), { type: "tool", toolName: "bash" });

  session.apply({
    type: "retry_changed",
    retrying: true,
    attempt: 1,
    maxAttempts: 3,
    delayMs: 2_000,
    retryAt: 12_000,
    errorMessage: "Network error",
  });
  assert.equal(agentActivity(session.snapshot()).type, "retrying");

  session.apply({ type: "compaction_changed", compacting: true });
  assert.deepEqual(agentActivity(session.snapshot()), { type: "compacting" });

  session.apply({ type: "tool_changed", toolCallId: "t1", toolName: "bash", status: "pending" });
  assert.deepEqual(agentActivity(session.snapshot()), { type: "permission", toolName: "bash" });
});
