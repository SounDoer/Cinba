// Folds Pi's stored session entries into the actions a UI cares about.
//
// The sibling of events.ts. That one folds the live event stream; this one
// folds what Pi has already written to its session file, which is how a
// reopened conversation gets drawn again.
//
// The split of duties behind this module:
//
//   Pi's session file  =  the past (finished, on disk)
//   our ledger         =  a projection of the past + the not-yet-stored present
//
// Pi's file is the single source of truth for history. The ledger holds nothing
// of its own that outlives a reload, so the two cannot drift into disagreement.
//
// A pure function over plain data: no Pi, no transport, no cost to test.

import { extractText } from "./events.ts";
import type { ViewAction } from "@cinba/contract";

/** One content part of a stored message. */
type Part = {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
};

type StoredMessage = {
  role?: unknown;
  content?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
  usage?: { totalTokens?: unknown; cost?: { total?: unknown } };
};

type StoredEntry = {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  message?: StoredMessage;
  provider?: unknown;
  modelId?: unknown;
};

/**
 * Select the path from the session root to its current leaf.
 *
 * Pi stores a session as an append-only tree. Entries from branches that are
 * no longer active remain in the file, so folding append order directly would
 * incorrectly draw every abandoned answer after an in-place edit.
 */
export function activeBranchEntries(entries: readonly unknown[], leafId: string | null): unknown[] {
  if (leafId === null) return [];

  const byId = new Map<string, StoredEntry>();
  for (const raw of entries) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as StoredEntry;
    if (typeof entry.id === "string") byId.set(entry.id, entry);
  }

  const branch: StoredEntry[] = [];
  const seen = new Set<string>();
  let current: string | null = leafId;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const entry = byId.get(current);
    if (!entry) break;
    branch.push(entry);
    current = typeof entry.parentId === "string" ? entry.parentId : null;
  }
  return branch.toReversed();
}

function parts(message: StoredMessage): Part[] {
  return Array.isArray(message.content) ? (message.content as Part[]) : [];
}

/**
 * Rebuild the view actions for a stored conversation, in order.
 *
 * Entries arrive over the wire, so every field is checked rather than trusted —
 * the same rule protocol.ts follows.
 */
export function foldSessionEntries(entries: readonly unknown[]): ViewAction[] {
  const actions: ViewAction[] = [];
  let totalTokens = 0;
  let totalCost = 0;

  for (const raw of entries) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as StoredEntry;

    if (entry.type === "model_change") {
      if (typeof entry.provider === "string" && typeof entry.modelId === "string") {
        actions.push({
          type: "model_in_use",
          provider: entry.provider,
          modelId: entry.modelId,
        });
      }
      continue;
    }

    // thinking_level_change, custom, label and the rest have nothing to draw in
    // this phase. Skipping the unknown rather than failing on it keeps old
    // sessions and future Pi versions readable.
    if (entry.type !== "message") continue;

    const message = entry.message;
    if (!message) continue;

    // A tool result belongs on its tool card, not in the transcript. It also
    // carries the outcome: a permission refusal arrives here as isError.
    if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string") continue;
      actions.push({
        type: "tool_changed",
        toolCallId: message.toolCallId,
        toolName: typeof message.toolName === "string" ? message.toolName : "",
        status: message.isError === true ? "error" : "done",
        result: extractText(message),
      });
      continue;
    }

    if (message.role !== "user" && message.role !== "assistant") continue;
    if (typeof entry.id !== "string" || entry.id === "") continue;

    // Pi's own entry id, rather than a counter of our own: it is stable across
    // rebuilds, which is what the reconciliation pass in the server needs.
    const messageId = entry.id;
    actions.push({ type: "message_added", messageId, role: message.role, stableId: true });

    // Walk the parts in their stored order so a tool call raised midway through
    // an answer lands between the text before it and the text after it.
    for (const part of parts(message)) {
      if (part.type === "text" && typeof part.text === "string") {
        actions.push({ type: "text_appended", messageId, text: part.text });
        continue;
      }
      if (part.type === "thinking" && typeof part.thinking === "string") {
        actions.push({ type: "thinking_appended", messageId, text: part.thinking });
        continue;
      }
      if (part.type === "toolCall" && typeof part.id === "string") {
        // Pending, because the result is a later entry. Replaying in order
        // moves the card to done or error when that entry arrives; a call whose
        // result never got stored correctly stays pending, which is the honest
        // rendering of an answer that was cut off mid-tool.
        actions.push({
          type: "tool_changed",
          toolCallId: part.id,
          toolName: typeof part.name === "string" ? part.name : "",
          args: part.arguments,
          status: "pending",
        });
      }
    }

    const usage = message.usage;
    if (usage) {
      if (typeof usage.totalTokens === "number") totalTokens += usage.totalTokens;
      if (typeof usage.cost?.total === "number") totalCost += usage.cost.total;
      actions.push({ type: "usage_changed", totalTokens, totalCost });
    }
  }

  return actions;
}
