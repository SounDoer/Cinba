// What the interface is told to do.
//
// The vocabulary both ends speak: the core produces these, every frontend
// applies them to its mirror of the ledger. It sits here rather than beside the
// folders that emit them because a browser needs the words without needing to
// know that Pi exists.

export type ToolStatus = "pending" | "running" | "done" | "error";

export type PendingMessages = {
  steering: string[];
  followUp: string[];
};

/** Current model context, distinct from cumulative session token spend. */
export type ContextUsage = {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
  /** True when tokens came from Pi's post-compaction estimate rather than provider usage. */
  estimated: boolean;
};

/** A scheduled retry of the model request that most recently failed. */
export type AutoRetry = {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  retryAt: number;
  errorMessage: string;
};

export type ViewAction =
  | {
      type: "message_added";
      messageId: string;
      role: "user" | "assistant";
      stableId: boolean;
    }
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
  | {
      type: "confirm_requested";
      requestId: string;
      title?: string;
      message?: string;
    }
  /**
   * Marks the point from which a given model was answering.
   *
   * Not invented here: Pi writes a model_change entry into its session file, so
   * this is a projection of that, both live and when a session is reopened.
   */
  | { type: "model_in_use"; provider: string; modelId: string }
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
  | { type: "context_changed"; context: ContextUsage }
  | {
      type: "compaction_changed";
      compacting: boolean;
      tokensBefore?: number;
      estimatedTokensAfter?: number;
      aborted?: boolean;
      error?: string;
    }
  | ({ type: "retry_changed" } & (
      | ({ retrying: true } & AutoRetry)
      | {
          retrying: false;
          success: boolean;
          attempt: number;
          finalError?: string;
        }
    ))
  | { type: "queue_changed"; steering: string[]; followUp: string[] }
  | { type: "busy_changed"; busy: boolean };
