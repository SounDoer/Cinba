// 会话账本：吃界面动作，维护「现在界面应该长什么样」。
//
// 这是唯一真相。渲染层只持有一份副本，任何时候都能靠 snapshot() 重建，
// 所以开发期间刷新界面不会丢对话。
// 依据：VS Code 对 webview 的官方指导——view 无状态，状态归 host。

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
  /** 有值表示这张卡片正等着用户点允许/拒绝，值是回应时要带的请求 id。 */
  confirmRequestId?: string;
};

export type Entry = MessageEntry | ToolEntry;

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

export function createSession(): Session {
  const entries: Entry[] = [];
  let totalTokens = 0;
  let totalCost = 0;
  let busy = false;

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
            // 状态一旦离开 pending，说明确认已有结果，标记该清了。
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
          // UI 请求不带 toolCallId，只能挂到最近一张待批准的卡片上。
          // Pi 在确认期间是阻塞的，正常情况下同时最多一个待确认项。
          for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i]!;
            if (entry.kind === "tool" && entry.status === "pending") {
              entry.confirmRequestId = action.requestId;
              return;
            }
          }
          return;
        }

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
