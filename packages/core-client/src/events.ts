// 把 Pi 的原始事件折叠成界面才关心的动作。
//
// 原始事件外面裹着一层信封，真正有用的在内层：
//   { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "好" } }
// 前端不该关心这层信封，所以在这里拆掉。
//
// 这个模块不依赖 Electron，也不依赖传输方式，因此能用 node --test 直接覆盖，
// 并且阶段 2 的 TUI、阶段 3 的网页版可以原样复用。

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
  | { type: "usage_changed"; totalTokens: number; totalCost: number }
  | { type: "busy_changed"; busy: boolean };

/**
 * 抽出 { content: [{ type: "text", text: "..." }] } 里的文本。
 * 工具结果与消息正文用的是同一种形状，所以共用这一个。
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
 * 造一个折叠器。每收到一个原始事件调用一次，返回 0 到多个界面动作。
 *
 * 有状态是必要的：Pi 的 message_start 不带 id，消息 id 得我们自己发；
 * 费用也需要跨事件累加。
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
        // toolResult 不进消息流：它的内容已经贴在工具卡片上了，再渲染一遍是重复。
        if (role !== "user" && role !== "assistant") return [];

        currentMessageId = `m${++messageCount}`;
        const actions: ViewAction[] = [
          { type: "message_added", messageId: currentMessageId, role },
        ];

        // 用户消息的正文在这里就已经完整了，不像助手消息靠后续的 text_delta 一点点填。
        // 助手消息此刻的 content 是空的，所以这段对它是空转。
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
        // 注意：这只表示「开始处理」。真正执行发生在权限确认之后，
        // 所以这里只能是 pending，渲染成「已执行」会给用户错误的安全感。
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

      // 忙 / 不忙完全能从事件流推出来，两半都在这里发，前端就不必各自补。
      // 前端仍可以在按下发送时自己先置一次 busy:true——那是为了立刻锁住输入框，
      // 不用等这个事件从管道那头回来；但即使忘了，行为也只是慢一拍，不会坏掉。
      case "agent_start":
        return [{ type: "busy_changed", busy: true }];

      case "agent_settled":
        return [{ type: "busy_changed", busy: false }];

      default:
        return [];
    }
  };
}

/** UI 请求里只有 confirm 需要变成界面动作，其余（notify 等）本阶段不渲染。 */
export function foldUiRequest(request: UiRequest): ViewAction | undefined {
  if (request.method !== "confirm") return undefined;
  return { type: "confirm_requested", requestId: request.id };
}
