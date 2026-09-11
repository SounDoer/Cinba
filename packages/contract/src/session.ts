// The session ledger: consumes view actions and maintains what the UI should
// currently look like.
//
// It is a projection, not a source of truth. Pi's session file holds the
// history; this holds a rendering of that history plus the part of the present
// that is not stored yet — the half-streamed answer, the tool card still
// awaiting approval. Nothing lives only here beyond a reload.
//
// The view in turn holds only a copy of this and can be rebuilt from snapshot()
// at any time, so reloading the UI during development does not lose the
// conversation. Basis: VS Code's official webview guidance — the view is
// stateless, the host owns the state.

import type { ToolStatus, ViewAction } from "./actions.ts";

export type MessageEntry = {
  kind: "message";
  messageId: string;
  /** True when messageId is Pi's persisted session entry id. */
  stableId: boolean;
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
  confirmTitle?: string;
  confirmMessage?: string;
};

/**
 * A system notice such as "aborted".
 *
 * Deliberately ephemeral: it is not stored anywhere and does not come back when
 * a session is reopened. That is what keeps the ledger free of any lasting data
 * of its own, and therefore a projection of Pi's session file rather than a
 * second source of truth competing with it.
 */
export type NoticeEntry = {
  kind: "notice";
  text: string;
};

/** Marks the point from which a given model was answering. Rebuilt from Pi's model_change entries. */
export type ModelEntry = {
  kind: "model";
  provider: string;
  modelId: string;
};

export type Entry = MessageEntry | ToolEntry | NoticeEntry | ModelEntry;

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
            stableId: action.stableId,
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
            if (action.status !== "pending") {
              existing.confirmRequestId = undefined;
              delete existing.confirmTitle;
              delete existing.confirmMessage;
            }
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
          // recent active card. Pi blocks while confirming, so under normal
          // conditions at most one confirmation is outstanding. Tool start is
          // optimistically running because most operations are auto-allowed;
          // receiving this request is what proves the exceptional one is pending.
          for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i]!;
            if (entry.kind === "tool" && (entry.status === "running" || entry.status === "pending")) {
              entry.status = "pending";
              entry.confirmRequestId = action.requestId;
              entry.confirmTitle = action.title;
              entry.confirmMessage = action.message;
              return;
            }
          }
          return;
        }

        case "notice":
          entries.push({ kind: "notice", text: action.text });
          return;

        case "model_in_use":
          entries.push({
            kind: "model",
            provider: action.provider,
            modelId: action.modelId,
          });
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

/**
 * Do two transcripts say the same thing?
 *
 * Compared by content, never by id: a transcript built live carries ids this
 * project invented while streaming, and the same transcript rebuilt from Pi's
 * file carries Pi's own. Comparing ids would report a difference every single
 * turn and make the check worthless.
 *
 * Notices are left out on purpose. They are ephemeral interface messages with
 * no counterpart in Pi's file, so their absence from the rebuilt side is
 * expected rather than a disagreement.
 */
export function sameTranscript(a: readonly Entry[], b: readonly Entry[]): boolean {
  const meaningful = (entries: readonly Entry[]) => entries.filter((entry) => entry.kind !== "notice");
  const left = meaningful(a);
  const right = meaningful(b);
  return (
    left.length === right.length &&
    left.every((entry, index) => sameMeaningfulEntry(entry, right[index]!))
  );
}

function sameMeaningfulEntry(left: Entry, right: Entry): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "message":
      return (
        right.kind === "message" &&
        left.role === right.role &&
        left.text === right.text &&
        left.thinking === right.thinking
      );
    case "tool":
      // The pending flag is left out: a card awaiting approval is part of the
      // present, and the present is not in Pi's file yet.
      return (
        right.kind === "tool" &&
        left.toolName === right.toolName &&
        left.status === right.status &&
        (left.result ?? "") === (right.result ?? "")
      );
    case "model":
      return (
        right.kind === "model" &&
        left.provider === right.provider &&
        left.modelId === right.modelId
      );
    default:
      return false;
  }
}
