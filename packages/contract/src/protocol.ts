// The wire protocol between server and client.
//
// Distinct from Pi's JSONL protocol: that one goes through transport.ts and
// client.ts and carries Pi's raw events. This one carries already-folded view
// actions and sits a level higher. Both sides share this single definition so
// the two ends cannot drift apart.

import type { ViewAction } from "./actions.ts";
import type { Snapshot } from "./session.ts";

/** Points at one model. Provider and id together, because ids are only unique within a provider. */
export type ModelRef = { provider: string; id: string };

/**
 * Whether a provider can be used, and never how.
 *
 * Shaped so it cannot carry a secret: a key travels to the core and never
 * comes back. See agent/credentials.ts.
 */
export type ProviderStatus = {
  id: string;
  name: string;
  configured: boolean;
};

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
  | { type: "rename_session"; name: string }
  | { type: "list_providers" }
  /** The one message in this protocol that carries a secret. It must never be logged, and nothing sends one back. */
  | { type: "set_api_key"; providerId: string; apiKey: string }
  | { type: "clear_credential"; providerId: string };

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
  | { type: "session_opened"; sessionId: string }
  | { type: "provider_listing"; providers: ProviderStatus[] }
  /**
   * Which core this is. Sent once, as soon as a client connects.
   *
   * Asserted by the core rather than remembered by the client on purpose: the
   * point is that the machine tells you what it is. A client that stored the
   * name against an address would show the wrong one the moment the address was
   * wrong, which is precisely the mistake this exists to prevent.
   */
  | { type: "core_identity"; name: string };

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

    case "list_providers":
      return { type: "list_providers" };

    case "set_api_key":
      if (
        typeof message.providerId !== "string" ||
        message.providerId === "" ||
        typeof message.apiKey !== "string" ||
        message.apiKey.trim() === ""
      ) {
        return undefined;
      }
      return {
        type: "set_api_key",
        providerId: message.providerId,
        apiKey: message.apiKey.trim(),
      };

    case "clear_credential":
      if (typeof message.providerId !== "string" || message.providerId === "") return undefined;
      return { type: "clear_credential", providerId: message.providerId };

    case "rename_session":
      if (typeof message.name !== "string" || message.name.trim() === "") return undefined;
      return { type: "rename_session", name: message.name.trim() };

    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isModelRef(value: unknown): value is ModelRef {
  return (
    isRecord(value) && typeof value.provider === "string" && typeof value.id === "string"
  );
}

function isToolStatus(value: unknown): boolean {
  return value === "pending" || value === "running" || value === "done" || value === "error";
}

function isViewAction(value: unknown): value is ViewAction {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "message_added":
      return (
        typeof value.messageId === "string" &&
        (value.role === "user" || value.role === "assistant")
      );
    case "text_appended":
    case "thinking_appended":
      return typeof value.messageId === "string" && typeof value.text === "string";
    case "tool_changed":
      return (
        typeof value.toolCallId === "string" &&
        typeof value.toolName === "string" &&
        isToolStatus(value.status) &&
        (value.result === undefined || typeof value.result === "string")
      );
    case "confirm_requested":
      return typeof value.requestId === "string";
    case "model_in_use":
      return typeof value.provider === "string" && typeof value.modelId === "string";
    case "notice":
      return typeof value.text === "string";
    case "usage_changed":
      return typeof value.totalTokens === "number" && typeof value.totalCost === "number";
    case "busy_changed":
      return typeof value.busy === "boolean";
    default:
      return false;
  }
}

function isEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "message":
      return (
        typeof value.messageId === "string" &&
        (value.role === "user" || value.role === "assistant") &&
        typeof value.text === "string" &&
        typeof value.thinking === "string"
      );
    case "tool":
      return (
        typeof value.toolCallId === "string" &&
        typeof value.toolName === "string" &&
        isToolStatus(value.status) &&
        (value.result === undefined || typeof value.result === "string") &&
        (value.confirmRequestId === undefined || typeof value.confirmRequestId === "string")
      );
    case "notice":
      return typeof value.text === "string";
    case "model":
      return typeof value.provider === "string" && typeof value.modelId === "string";
    default:
      return false;
  }
}

function isSnapshot(value: unknown): value is Snapshot {
  return (
    isRecord(value) &&
    Array.isArray(value.entries) &&
    value.entries.every(isEntry) &&
    typeof value.totalTokens === "number" &&
    typeof value.totalCost === "number" &&
    typeof value.busy === "boolean"
  );
}

function isSessionSummary(value: unknown): value is SessionSummary {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.cwd === "string" &&
    (value.name === undefined || typeof value.name === "string") &&
    typeof value.messageCount === "number" &&
    typeof value.firstMessage === "string" &&
    typeof value.modified === "string"
  );
}

function isProviderStatus(value: unknown): value is ProviderStatus {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.configured === "boolean"
  );
}

/** Validate a message received by a client before dispatching it to UI code. */
export function parseServerMessage(raw: unknown): ServerMessage | undefined {
  if (!isRecord(raw)) return undefined;

  switch (raw.type) {
    case "snapshot":
      if (
        !isSnapshot(raw.snapshot) ||
        typeof raw.cwd !== "string" ||
        typeof raw.sessionId !== "string" ||
        (raw.model !== undefined && !isModelRef(raw.model))
      ) {
        return undefined;
      }
      return raw as ServerMessage;
    case "actions":
      return Array.isArray(raw.actions) && raw.actions.every(isViewAction)
        ? (raw as ServerMessage)
        : undefined;
    case "dir_listing":
      return typeof raw.path === "string" &&
        (raw.parent === null || typeof raw.parent === "string") &&
        Array.isArray(raw.dirs) &&
        raw.dirs.every((dir) => typeof dir === "string")
        ? (raw as ServerMessage)
        : undefined;
    case "model_listing":
      return Array.isArray(raw.models) && raw.models.every(isModelRef)
        ? (raw as ServerMessage)
        : undefined;
    case "model_changed":
      return isModelRef(raw.model) ? (raw as ServerMessage) : undefined;
    case "session_listing":
      return Array.isArray(raw.sessions) && raw.sessions.every(isSessionSummary)
        ? (raw as ServerMessage)
        : undefined;
    case "session_opened":
      return typeof raw.sessionId === "string" ? (raw as ServerMessage) : undefined;
    case "provider_listing":
      return Array.isArray(raw.providers) && raw.providers.every(isProviderStatus)
        ? (raw as ServerMessage)
        : undefined;
    case "core_identity":
      return typeof raw.name === "string" ? (raw as ServerMessage) : undefined;
    default:
      return undefined;
  }
}
