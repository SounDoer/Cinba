// Folds Pi's raw events into the actions a UI actually cares about.
//
// Raw events arrive wrapped in an envelope, with the useful part nested inside:
//   { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }
// A frontend should not have to know about that envelope, so it comes off here.
//
// This module depends on neither Electron nor any transport, so node --test can
// cover it directly, and the phase 2 TUI and phase 3 web UI reuse it as is.

import type { CoreEvent, UiRequest } from "./client.ts";

export type ToolStatus = "pending" | "running" | "done" | "error";

export type ViewAction =
  | { type: "message_added"; messageId: string; role: "user" | "assistant" }
  | { type: "text_appended"; messageId: string; text: string }
  | { type: "thinking_appended"; messageId: string; text: string }
  | {
      type: "tool_changed";
      toolCallId: string;
      toolName: string;
      args?: unknown;
      status: ToolStatus;
      result?: string;
    }
  | { type: "confirm_requested"; requestId: string }
  /**
   * A system notice such as "aborted".
   *
   * The folder never produces one: it does not come from Pi's event stream but
   * from the host or a frontend after the user acts. It travels this channel
   * rather than being printed straight to the screen so that it enters the
   * ledger like everything else and survives a reload.
   */
  | { type: "notice"; text: string }
  | { type: "usage_changed"; totalTokens: number; totalCost: number }
  | { type: "busy_changed"; busy: boolean };

/**
 * Pull the text out of { content: [{ type: "text", text: "..." }] }.
 * Tool results and message bodies share this shape, so they share this helper.
 */
function extractText(carrier: unknown): string {
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
          { type: "message_added", messageId: currentMessageId, role },
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
        if (typeof inner?.delta !== "string") return [];
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
            | { usage?: { totalTokens?: number; cost?: { total?: number } } }
            | undefined
        )?.usage;
        if (!usage) return [];
        totalTokens += usage.totalTokens ?? 0;
        totalCost += usage.cost?.total ?? 0;
        return [{ type: "usage_changed", totalTokens, totalCost }];
      }

      case "tool_execution_start":
        // Note: this only means processing started. Execution happens after the
        // permission confirmation, so the status here can only be pending —
        // rendering it as executed would give the user false reassurance.
        return [
          {
            type: "tool_changed",
            toolCallId: String(event.toolCallId),
            toolName: String(event.toolName),
            args: event.args,
            status: "pending",
          },
        ];

      case "tool_execution_end":
        return [
          {
            type: "tool_changed",
            toolCallId: String(event.toolCallId),
            toolName: String(event.toolName),
            status: event.isError === true ? "error" : "done",
            result: extractText(event.result),
          },
        ];

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
  return { type: "confirm_requested", requestId: request.id };
}
