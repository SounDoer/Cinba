// The one-line answer to "what is this agent doing right now?"
//
// Keeping this projection in the contract makes every client use the same
// priority when several pieces of transient state overlap.

import type { AutoRetry } from "./actions.ts";
import type { Snapshot } from "./session.ts";

export type AgentActivity =
  | { type: "permission"; toolName: string }
  | { type: "compacting" }
  | ({ type: "retrying" } & AutoRetry)
  | { type: "tool"; toolName: string }
  | { type: "answering" }
  | { type: "idle" };

export function agentActivity(snapshot: Snapshot): AgentActivity {
  const tools = snapshot.entries.filter((entry) => entry.kind === "tool");
  const pending = tools.findLast((entry) => entry.status === "pending");
  if (pending?.kind === "tool") {
    return { type: "permission", toolName: pending.toolName };
  }
  if (snapshot.compacting) {
    return { type: "compacting" };
  }
  if (snapshot.retry) {
    return { type: "retrying", ...snapshot.retry };
  }
  const running = tools.findLast((entry) => entry.status === "running");
  if (running?.kind === "tool") {
    return { type: "tool", toolName: running.toolName };
  }
  return snapshot.busy ? { type: "answering" } : { type: "idle" };
}
