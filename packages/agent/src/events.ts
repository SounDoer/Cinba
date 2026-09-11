// Folds Pi's raw events into the actions a UI actually cares about.
//
// Raw events arrive wrapped in an envelope, with the useful part nested inside:
//   { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }
// A frontend should not have to know about that envelope, so it comes off here.
//
// This module depends on neither Electron nor any transport, so node --test can
// cover it directly, and the phase 2 TUI and phase 3 web UI reuse it as is.

import type { ViewAction } from "@cinba/contract";
import type { CoreEvent, UiRequest } from "./pi-client.ts";

/**
 * Pull the text out of { content: [{ type: "text", text: "..." }] }.
 *
 * Tool results and message bodies share this shape, so they share this helper.
 * Exported within the package because entries.ts folds the same shape out of
 * Pi's stored session entries.
 */
export function extractText(carrier: unknown): string {
  const content = (carrier as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } => {
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string";
    })
    .map((part) => part.text)
    .join("");
}

/**
 * Make a folder. Call it once per raw event; it returns zero or more view actions.
 *
 * Keeping state is necessary: Pi's message_start carries no id, so we issue
 * message ids ourselves, and cost has to accumulate across events.
 */
export function createEventFolder(): (event: CoreEvent) => ViewAction[] {
  let messageCount = 0;
  let currentMessageId = "";
  let totalTokens = 0;
  let totalCost = 0;

  return (event: CoreEvent): ViewAction[] => {
    switch (event.type) {
      case "message_start": {
        const message = event.message as { role?: string; content?: unknown } | undefined;
        const role = message?.role;
        // toolResult stays out of the transcript: its content is already on the tool card.
        if (role !== "user" && role !== "assistant") return [];

        currentMessageId = `m${++messageCount}`;
        const actions: ViewAction[] = [
          { type: "message_added", messageId: currentMessageId, role, stableId: false },
        ];

        // A user message is already complete here, unlike an assistant message
        // that fills in through later text_delta events. An assistant message
        // has empty content at this point, so this block is a no-op for it.
        const text = extractText(message);
        if (text) {
          actions.push({ type: "text_appended", messageId: currentMessageId, text });
        }

        return actions;
      }

      case "message_update": {
        const inner = event.assistantMessageEvent as
          | { type?: string; delta?: unknown }
          | undefined;
        if (currentMessageId === "" || typeof inner?.delta !== "string") return [];
        if (inner.type === "text_delta") {
          return [{ type: "text_appended", messageId: currentMessageId, text: inner.delta }];
        }
        if (inner.type === "thinking_delta") {
          return [{ type: "thinking_appended", messageId: currentMessageId, text: inner.delta }];
        }
        return [];
      }

      case "message_end": {
        const usage = (
          event.message as
            | { usage?: { totalTokens?: unknown; cost?: { total?: unknown } } }
            | undefined
        )?.usage;
        if (!usage) return [];
        let changed = false;
        if (typeof usage.totalTokens === "number") {
          totalTokens += usage.totalTokens;
          changed = true;
        }
        if (typeof usage.cost?.total === "number") {
          totalCost += usage.cost.total;
          changed = true;
        }
        if (!changed) return [];
        return [{ type: "usage_changed", totalTokens, totalCost }];
      }

      case "tool_execution_start": {
        if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return [];
        // Most tools now pass the permission policy without a prompt. A later
        // confirm_requested action moves an exceptional tool back to pending.
        return [
          {
            type: "tool_changed",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            status: "running",
          },
        ];
      }

      case "tool_execution_end": {
        if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return [];
        return [
          {
            type: "tool_changed",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: event.isError === true ? "error" : "done",
            result: extractText(event.result),
          },
        ];
      }

      // Busy and idle are both derivable from the event stream, and emitting
      // both halves here saves every frontend from patching it in itself.
      // A frontend may still set busy:true when send is pressed, to lock the
      // input immediately instead of waiting for this event to come back down
      // the pipe; forgetting to costs a beat of latency, nothing more.
      case "agent_start":
        return [{ type: "busy_changed", busy: true }];

      case "agent_settled":
        return [{ type: "busy_changed", busy: false }];

      default:
        return [];
    }
  };
}

/** Of the UI requests only confirm becomes a view action; the rest (notify and friends) are not rendered in this phase. */
export function foldUiRequest(request: UiRequest): ViewAction | undefined {
  if (request.method !== "confirm") return undefined;
  return {
    type: "confirm_requested",
    requestId: request.id,
    title: typeof request.title === "string" ? request.title : undefined,
    message: typeof request.message === "string" ? request.message : undefined,
  };
}
