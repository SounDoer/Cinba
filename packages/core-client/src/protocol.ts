// The wire protocol between server and client.
//
// Distinct from Pi's JSONL protocol: that one goes through transport.ts and
// client.ts and carries Pi's raw events. This one carries already-folded view
// actions and sits a level higher. Both sides share this single definition so
// the two ends cannot drift apart.

import type { ViewAction } from "./events.ts";
import type { Snapshot } from "./session.ts";

/** Points at one model. Provider and id together, because ids are only unique within a provider. */
export type ModelRef = { provider: string; id: string };

/**
 * One row of the session list.
 *
 * Straight out of Pi's SessionInfo, trimmed to what a picker draws. firstMessage
 * is the opening line of the conversation and serves as the title: Pi already
 * has it, so nothing has to invent one.
 */
export type SessionSummary = {
  id: string;
  cwd: string;
  name?: string;
  messageCount: number;
  firstMessage: string;
  /** ISO 8601. A Date does not survive JSON. */
  modified: string;
};

/** Client to server. */
export type ClientMessage =
  | { type: "prompt"; text: string }
  | { type: "abort" }
  | { type: "respond_confirm"; requestId: string; confirmed: boolean }
  | { type: "list_dir"; path: string }
  | { type: "list_models" }
  | { type: "set_model"; provider: string; modelId: string }
  /** cwd absent means every directory. */
  | { type: "list_sessions"; cwd?: string }
  | { type: "open_session"; sessionId: string }
  | { type: "create_session"; cwd: string }
  | { type: "delete_session"; sessionId: string }
  /** Names the conversation this client is in, the same as prompt and set_model act on it. */
  | { type: "rename_session"; name: string };

/** Server to client. */
export type ServerMessage =
  /**
   * The state of one session. sessionId says which, because a client may be
   * looking at a different one from its neighbour.
   *
   * model is absent only in the moment before the server has asked Pi which one it picked.
   */
  | { type: "snapshot"; snapshot: Snapshot; cwd: string; sessionId: string; model?: ModelRef }
  | { type: "actions"; actions: ViewAction[] }
  /** parent is the path one level up, or null at the root. dirs holds subdirectory names only, no files. */
  | { type: "dir_listing"; path: string; parent: string | null; dirs: string[] }
  /** Only the models with credentials configured on the core's machine; the rest are unusable anyway. */
  | { type: "model_listing"; models: ModelRef[] }
  | { type: "model_changed"; model: ModelRef }
  | { type: "session_listing"; sessions: SessionSummary[] }
  /** Which session this client is now looking at. The snapshot for it follows. */
  | { type: "session_opened"; sessionId: string };

/**
 * Validate a message from a client; return undefined for anything unrecognized
 * so the caller can drop it.
 *
 * Anything arriving over the network is untrusted, so every field gets a type
 * check — even though we currently listen on the loopback address only. By the
 * time 3b opens a real door outward, this check is already in place.
 */
export function parseClientMessage(raw: unknown): ClientMessage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const message = raw as Record<string, unknown>;

  switch (message.type) {
    case "prompt":
      if (typeof message.text !== "string" || message.text.trim() === "") return undefined;
      return { type: "prompt", text: message.text };

    case "abort":
      return { type: "abort" };

    case "respond_confirm":
      if (typeof message.requestId !== "string" || typeof message.confirmed !== "boolean") {
        return undefined;
      }
      return {
        type: "respond_confirm",
        requestId: message.requestId,
        confirmed: message.confirmed,
      };

    case "list_dir":
      if (typeof message.path !== "string" || message.path === "") return undefined;
      return { type: "list_dir", path: message.path };

    case "list_models":
      return { type: "list_models" };

    case "set_model":
      if (
        typeof message.provider !== "string" ||
        message.provider === "" ||
        typeof message.modelId !== "string" ||
        message.modelId === ""
      ) {
        return undefined;
      }
      return { type: "set_model", provider: message.provider, modelId: message.modelId };

    case "list_sessions":
      if (message.cwd === undefined) return { type: "list_sessions" };
      if (typeof message.cwd !== "string" || message.cwd === "") return undefined;
      return { type: "list_sessions", cwd: message.cwd };

    case "open_session":
      if (typeof message.sessionId !== "string" || message.sessionId === "") return undefined;
      return { type: "open_session", sessionId: message.sessionId };

    case "create_session":
      if (typeof message.cwd !== "string" || message.cwd === "") return undefined;
      return { type: "create_session", cwd: message.cwd };

    case "delete_session":
      if (typeof message.sessionId !== "string" || message.sessionId === "") return undefined;
      return { type: "delete_session", sessionId: message.sessionId };

    case "rename_session":
      if (typeof message.name !== "string" || message.name.trim() === "") return undefined;
      return { type: "rename_session", name: message.name.trim() };

    default:
      return undefined;
  }
}
