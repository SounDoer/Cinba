// The session ledger: consumes view actions and maintains what the UI should
// currently look like.
//
// This is the single source of truth. The view holds only a copy and can be
// rebuilt from snapshot() at any time, so reloading the UI during development
// does not lose the conversation.
// Basis: VS Code's official webview guidance — the view is stateless, the host
// owns the state.

import type { ToolStatus, ViewAction } from "./events.ts";

export type MessageEntry = {
  kind: "message";
  messageId: string;
  role: "user" | "assistant";
  text: string;
  thinking: string;
};

export type ToolEntry = {
  kind: "tool";
  toolCallId: string;
  toolName: string;
  args?: unknown;
  status: ToolStatus;
  result?: string;
  /** Set while this card awaits an allow/deny click; the value is the request id to answer with. */
  confirmRequestId?: string;
};

/** A system notice such as "aborted". Nobody said it, so it gets its own kind. */
export type NoticeEntry = {
  kind: "notice";
  text: string;
};

export type Entry = MessageEntry | ToolEntry | NoticeEntry;

export type Snapshot = {
  entries: Entry[];
  totalTokens: number;
  totalCost: number;
  busy: boolean;
};

export type Session = {
  apply(action: ViewAction): void;
  snapshot(): Snapshot;
};

/**
 * @param initial Start from an existing snapshot. Useful for the mirror ledger
 *                on the client side: take a snapshot on connect, then follow
 *                the incremental actions.
 */
export function createSession(initial?: Snapshot): Session {
  // Copy, so later edits by the caller to that snapshot cannot reach in here.
  const entries: Entry[] = (initial?.entries ?? []).map((entry) => ({ ...entry }));
  let totalTokens = initial?.totalTokens ?? 0;
  let totalCost = initial?.totalCost ?? 0;
  let busy = initial?.busy ?? false;

  function findMessage(messageId: string): MessageEntry | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      if (entry.kind === "message" && entry.messageId === messageId) return entry;
    }
    return undefined;
  }

  function findTool(toolCallId: string): ToolEntry | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      if (entry.kind === "tool" && entry.toolCallId === toolCallId) return entry;
    }
    return undefined;
  }

  return {
    apply(action: ViewAction): void {
      switch (action.type) {
        case "message_added":
          entries.push({
            kind: "message",
            messageId: action.messageId,
            role: action.role,
            text: "",
            thinking: "",
          });
          return;

        case "text_appended": {
          const message = findMessage(action.messageId);
          if (message) message.text += action.text;
          return;
        }

        case "thinking_appended": {
          const message = findMessage(action.messageId);
          if (message) message.thinking += action.text;
          return;
        }

        case "tool_changed": {
          const existing = findTool(action.toolCallId);
          if (existing) {
            existing.status = action.status;
            if (action.args !== undefined) existing.args = action.args;
            if (action.result !== undefined) existing.result = action.result;
            // Leaving pending means the confirmation resolved; clear the marker.
            if (action.status !== "pending") existing.confirmRequestId = undefined;
            return;
          }
          entries.push({
            kind: "tool",
            toolCallId: action.toolCallId,
            toolName: action.toolName,
            args: action.args,
            status: action.status,
            result: action.result,
            confirmRequestId: undefined,
          });
          return;
        }

        case "confirm_requested": {
          // The UI request carries no toolCallId, so attach it to the most
          // recent pending card. Pi blocks while confirming, so under normal
          // conditions at most one confirmation is outstanding.
          for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i]!;
            if (entry.kind === "tool" && entry.status === "pending") {
              entry.confirmRequestId = action.requestId;
              return;
            }
          }
          return;
        }

        case "notice":
          entries.push({ kind: "notice", text: action.text });
          return;

        case "usage_changed":
          totalTokens = action.totalTokens;
          totalCost = action.totalCost;
          return;

        case "busy_changed":
          busy = action.busy;
          return;
      }
    },

    snapshot(): Snapshot {
      return {
        entries: entries.map((entry) => ({ ...entry })),
        totalTokens,
        totalCost,
        busy,
      };
    },
  };
}
