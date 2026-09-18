// The wire protocol between server and client.
//
// Distinct from Pi's JSONL protocol: that one goes through transport.ts and
// client.ts and carries Pi's raw events. This one carries already-folded view
// actions and sits a level higher. Both sides share this single definition so
// the two ends cannot drift apart.

import type { ViewAction } from "./actions.ts";
import { type CoreHello, parseCoreHello } from "./compatibility.ts";
import type { SkillCommand } from "./commands.ts";
import type { Snapshot } from "./session.ts";
import { type ThinkingLevel, isThinkingLevel } from "./thinking.ts";

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
  /** Effective non-secret credential state. Optional for compatibility with older Cores. */
  source?: "local-api-key" | "local-oauth" | "sync-api-key" | "conflict";
  management?: "local" | "sync";
};

export type WebSearchProviderId = "exa" | "brave" | "duckduckgo";
export type WebSearchCredentialProviderId = "exa" | "brave";
export type WebSearchPrimary = "auto" | "exa" | "brave";
export type WebSearchCredentialSource = "environment" | "stored" | "sync";
export type WebToolsConfigurationSource = "local" | "sync";

export type WebSearchProviderStatus = {
  id: WebSearchProviderId;
  name: string;
  available: boolean;
  source?: WebSearchCredentialSource;
  hasStoredCredential: boolean;
  bestEffort: boolean;
};

export type WebToolsStatus = {
  primary: WebSearchPrimary;
  effectiveOrder: WebSearchProviderId[];
  providers: WebSearchProviderStatus[];
  /** Optional only for compatibility with a Core from before Sync source reporting. */
  settingsSource?: WebToolsConfigurationSource;
  credentialSource?: WebToolsConfigurationSource;
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

export type PromptStreamingBehavior = "steer" | "followUp";
export type RecoveredDraft = { text: string; behavior: PromptStreamingBehavior };

/** Client to server. */
export type ClientMessage =
  | { type: "prompt"; text: string; streamingBehavior?: PromptStreamingBehavior }
  | { type: "clear_queue" }
  | { type: "compact" }
  | { type: "abort_retry" }
  | { type: "edit_message"; entryId: string; text: string }
  | { type: "abort" }
  | { type: "respond_confirm"; requestId: string; confirmed: boolean }
  | { type: "respond_project_trust"; requestId: string; trusted: boolean }
  | { type: "list_dir"; path: string }
  | { type: "list_models" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: ThinkingLevel }
  | { type: "cycle_thinking_level" }
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
  | { type: "clear_credential"; providerId: string }
  | { type: "get_web_tools_status" }
  | { type: "set_web_tools_api_key"; providerId: WebSearchCredentialProviderId; apiKey: string }
  | { type: "clear_web_tools_api_key"; providerId: WebSearchCredentialProviderId }
  | { type: "set_web_search_primary"; primary: WebSearchPrimary };

/** Server to client. */
export type ServerMessage =
  | ({ type: "core_hello" } & CoreHello)
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
  | { type: "web_tools_status"; status: WebToolsStatus; error?: string }
  | { type: "drafts_recovered"; drafts: RecoveredDraft[] }
  | { type: "skill_listing"; sessionId: string; skills: SkillCommand[] }
  | { type: "project_trust_requested"; requestId: string; cwd: string; resources: string[] }
  /**
   * Which core this is. Sent once, as soon as a client connects.
   *
   * Asserted by the core rather than remembered by the client on purpose: the
   * point is that the machine tells you what it is. A client that stored the
   * name against an address would show the wrong one the moment the address was
   * wrong, which is precisely the mistake this exists to prevent.
   */
  | { type: "core_identity"; name: string };

type WebToolsClientMessage = Extract<
  ClientMessage,
  {
    type:
      | "get_web_tools_status"
      | "set_web_tools_api_key"
      | "clear_web_tools_api_key"
      | "set_web_search_primary";
  }
>;

type PromptClientMessage = Extract<ClientMessage, { type: "prompt" | "clear_queue" }>;
type ThinkingClientMessage = Extract<
  ClientMessage,
  { type: "set_thinking_level" | "cycle_thinking_level" }
>;
type SimpleClientMessage = Extract<ClientMessage, { type: "abort" | "abort_retry" | "compact" }>;

function parseSimpleClientMessage(
  message: Record<string, unknown>,
): SimpleClientMessage | undefined {
  switch (message.type) {
    case "abort":
    case "abort_retry":
    case "compact":
      return hasOnlyKeys(message, ["type"]) ? { type: message.type } : undefined;
    default:
      return undefined;
  }
}

function parsePromptClientMessage(
  message: Record<string, unknown>,
): PromptClientMessage | undefined {
  if (message.type === "clear_queue") {
    return hasOnlyKeys(message, ["type"]) ? { type: "clear_queue" } : undefined;
  }
  if (message.type !== "prompt") {
    return undefined;
  }
  if (
    !hasOnlyKeys(message, ["type", "text", "streamingBehavior"]) ||
    typeof message.text !== "string" ||
    message.text.trim() === "" ||
    (message.streamingBehavior !== undefined &&
      message.streamingBehavior !== "steer" &&
      message.streamingBehavior !== "followUp")
  ) {
    return undefined;
  }
  return message.streamingBehavior === undefined
    ? { type: "prompt", text: message.text }
    : {
        type: "prompt",
        text: message.text,
        streamingBehavior: message.streamingBehavior,
      };
}

function parseThinkingClientMessage(
  message: Record<string, unknown>,
): ThinkingClientMessage | undefined {
  if (message.type === "cycle_thinking_level") {
    return hasOnlyKeys(message, ["type"]) ? { type: "cycle_thinking_level" } : undefined;
  }
  if (message.type !== "set_thinking_level") {
    return undefined;
  }
  return hasOnlyKeys(message, ["type", "level"]) && isThinkingLevel(message.level)
    ? { type: "set_thinking_level", level: message.level }
    : undefined;
}

function parseWebToolsClientMessage(
  message: Record<string, unknown>,
): WebToolsClientMessage | undefined {
  switch (message.type) {
    case "get_web_tools_status":
      return hasOnlyKeys(message, ["type"]) ? { type: "get_web_tools_status" } : undefined;
    case "set_web_tools_api_key":
      if (
        !hasOnlyKeys(message, ["type", "providerId", "apiKey"]) ||
        !isWebSearchCredentialProviderId(message.providerId) ||
        typeof message.apiKey !== "string" ||
        message.apiKey.trim() === ""
      ) {
        return undefined;
      }
      return {
        type: "set_web_tools_api_key",
        providerId: message.providerId,
        apiKey: message.apiKey.trim(),
      };
    case "clear_web_tools_api_key":
      return hasOnlyKeys(message, ["type", "providerId"]) &&
        isWebSearchCredentialProviderId(message.providerId)
        ? { type: "clear_web_tools_api_key", providerId: message.providerId }
        : undefined;
    case "set_web_search_primary":
      return hasOnlyKeys(message, ["type", "primary"]) && isWebSearchPrimary(message.primary)
        ? { type: "set_web_search_primary", primary: message.primary }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Validate a message from a client; return undefined for anything unrecognized
 * so the caller can drop it.
 *
 * Anything arriving over the network is untrusted, so every field gets a type
 * check — even though we currently listen on the loopback address only. By the
 * time 3b opens a real door outward, this check is already in place.
 */
// The switch is intentionally exhaustive at this trust boundary.
// oxlint-disable-next-line complexity
export function parseClientMessage(raw: unknown): ClientMessage | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const message = raw as Record<string, unknown>;
  const promptMessage = parsePromptClientMessage(message);
  if (promptMessage) {
    return promptMessage;
  }
  const simpleMessage = parseSimpleClientMessage(message);
  if (simpleMessage) {
    return simpleMessage;
  }
  const webToolsMessage = parseWebToolsClientMessage(message);
  if (webToolsMessage) {
    return webToolsMessage;
  }
  const thinkingMessage = parseThinkingClientMessage(message);
  if (thinkingMessage) {
    return thinkingMessage;
  }

  switch (message.type) {
    case "edit_message":
      if (
        typeof message.entryId !== "string" ||
        message.entryId.trim() === "" ||
        typeof message.text !== "string" ||
        message.text.trim() === ""
      ) {
        return undefined;
      }
      return {
        type: "edit_message",
        entryId: message.entryId,
        text: message.text,
      };

    case "respond_confirm":
      if (typeof message.requestId !== "string" || typeof message.confirmed !== "boolean") {
        return undefined;
      }
      return {
        type: "respond_confirm",
        requestId: message.requestId,
        confirmed: message.confirmed,
      };

    case "respond_project_trust":
      if (typeof message.requestId !== "string" || typeof message.trusted !== "boolean") {
        return undefined;
      }
      return {
        type: "respond_project_trust",
        requestId: message.requestId,
        trusted: message.trusted,
      };

    case "list_dir":
      if (typeof message.path !== "string" || message.path === "") {
        return undefined;
      }
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
      if (message.cwd === undefined) {
        return { type: "list_sessions" };
      }
      if (typeof message.cwd !== "string" || message.cwd === "") {
        return undefined;
      }
      return { type: "list_sessions", cwd: message.cwd };

    case "open_session":
      if (typeof message.sessionId !== "string" || message.sessionId === "") {
        return undefined;
      }
      return { type: "open_session", sessionId: message.sessionId };

    case "create_session":
      if (typeof message.cwd !== "string" || message.cwd === "") {
        return undefined;
      }
      return { type: "create_session", cwd: message.cwd };

    case "delete_session":
      if (typeof message.sessionId !== "string" || message.sessionId === "") {
        return undefined;
      }
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
      if (typeof message.providerId !== "string" || message.providerId === "") {
        return undefined;
      }
      return { type: "clear_credential", providerId: message.providerId };

    case "rename_session":
      if (typeof message.name !== "string" || message.name.trim() === "") {
        return undefined;
      }
      return { type: "rename_session", name: message.name.trim() };

    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed);
  return Object.keys(value).every((key) => accepted.has(key));
}

function isWebSearchProviderId(value: unknown): value is WebSearchProviderId {
  return value === "exa" || value === "brave" || value === "duckduckgo";
}

function isWebSearchCredentialProviderId(value: unknown): value is WebSearchCredentialProviderId {
  return value === "exa" || value === "brave";
}

function isWebSearchPrimary(value: unknown): value is WebSearchPrimary {
  return value === "auto" || value === "exa" || value === "brave";
}

function isModelRef(value: unknown): value is ModelRef {
  return isRecord(value) && typeof value.provider === "string" && typeof value.id === "string";
}

function isToolStatus(value: unknown): boolean {
  return value === "pending" || value === "running" || value === "done" || value === "error";
}

function isThinkingAction(value: Record<string, unknown>): boolean {
  return (
    value.type === "thinking_changed" &&
    isThinkingLevel(value.level) &&
    (value.available === undefined ||
      (Array.isArray(value.available) && value.available.every(isThinkingLevel)))
  );
}

function isViewAction(value: unknown): value is ViewAction {
  if (!isRecord(value)) {
    return false;
  }
  if (isThinkingAction(value)) {
    return true;
  }
  switch (value.type) {
    case "message_added":
      return (
        typeof value.messageId === "string" &&
        typeof value.stableId === "boolean" &&
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
      return (
        typeof value.requestId === "string" &&
        (value.title === undefined || typeof value.title === "string") &&
        (value.message === undefined || typeof value.message === "string")
      );
    case "model_in_use":
      return typeof value.provider === "string" && typeof value.modelId === "string";
    case "notice":
      return typeof value.text === "string";
    case "usage_changed":
      return typeof value.totalTokens === "number" && typeof value.totalCost === "number";
    case "context_changed":
      return isContextUsage(value.context);
    case "compaction_changed":
      return (
        typeof value.compacting === "boolean" &&
        (value.tokensBefore === undefined || typeof value.tokensBefore === "number") &&
        (value.estimatedTokensAfter === undefined ||
          typeof value.estimatedTokensAfter === "number") &&
        (value.aborted === undefined || typeof value.aborted === "boolean") &&
        (value.error === undefined || typeof value.error === "string")
      );
    case "retry_changed":
      if (value.retrying === true) {
        return (
          typeof value.attempt === "number" &&
          typeof value.maxAttempts === "number" &&
          typeof value.delayMs === "number" &&
          typeof value.retryAt === "number" &&
          typeof value.errorMessage === "string"
        );
      }
      return (
        value.retrying === false &&
        typeof value.success === "boolean" &&
        typeof value.attempt === "number" &&
        (value.finalError === undefined || typeof value.finalError === "string")
      );
    case "busy_changed":
      return typeof value.busy === "boolean";
    case "queue_changed":
      return isStringArray(value.steering) && isStringArray(value.followUp);
    default:
      return false;
  }
}

function isEntry(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.kind) {
    case "message":
      return (
        typeof value.messageId === "string" &&
        typeof value.stableId === "boolean" &&
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
        (value.confirmRequestId === undefined || typeof value.confirmRequestId === "string") &&
        (value.confirmTitle === undefined || typeof value.confirmTitle === "string") &&
        (value.confirmMessage === undefined || typeof value.confirmMessage === "string")
      );
    case "notice":
      return typeof value.text === "string";
    case "model":
      return typeof value.provider === "string" && typeof value.modelId === "string";
    default:
      return false;
  }
}

function parseSnapshot(value: unknown): Snapshot | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.entries) ||
    !value.entries.every(isEntry) ||
    typeof value.totalTokens !== "number" ||
    typeof value.totalCost !== "number" ||
    typeof value.busy !== "boolean" ||
    typeof value.compacting !== "boolean" ||
    (value.retry !== undefined && value.retry !== null && !isAutoRetry(value.retry)) ||
    !isContextUsage(value.context) ||
    (value.thinking !== undefined && !isThinkingState(value.thinking)) ||
    !isPendingMessages(value.queue)
  ) {
    return undefined;
  }

  // A persistent Core can briefly outlive a Desktop update. Defaults for
  // additive fields keep that rolling upgrade usable until the Core restarts.
  if (value.retry === undefined || value.thinking === undefined) {
    return {
      ...(value as unknown as Snapshot),
      retry: value.retry === undefined ? null : value.retry,
      thinking:
        value.thinking === undefined ? { level: "off", available: ["off"] } : value.thinking,
    } as Snapshot;
  }
  return value as unknown as Snapshot;
}

function isThinkingState(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["level", "available"]) &&
    isThinkingLevel(value.level) &&
    Array.isArray(value.available) &&
    value.available.length > 0 &&
    value.available.every(isThinkingLevel)
  );
}

function isAutoRetry(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["attempt", "maxAttempts", "delayMs", "retryAt", "errorMessage"]) &&
    typeof value.attempt === "number" &&
    typeof value.maxAttempts === "number" &&
    typeof value.delayMs === "number" &&
    typeof value.retryAt === "number" &&
    typeof value.errorMessage === "string"
  );
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function isContextUsage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["tokens", "contextWindow", "percent", "estimated"]) &&
    isNullableNumber(value.tokens) &&
    isNullableNumber(value.contextWindow) &&
    isNullableNumber(value.percent) &&
    typeof value.estimated === "boolean"
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPendingMessages(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["steering", "followUp"]) &&
    isStringArray(value.steering) &&
    isStringArray(value.followUp)
  );
}

function isRecoveredDraft(value: unknown): value is RecoveredDraft {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["text", "behavior"]) &&
    typeof value.text === "string" &&
    (value.behavior === "steer" || value.behavior === "followUp")
  );
}

function isSkillCommand(value: unknown): value is SkillCommand {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["source", "name", "summary", "scope"]) &&
    value.source === "skill" &&
    typeof value.name === "string" &&
    value.name.startsWith("skill:") &&
    value.name.length > "skill:".length &&
    typeof value.summary === "string" &&
    (value.scope === "user" || value.scope === "project" || value.scope === "path")
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
    hasOnlyKeys(value, ["id", "name", "configured", "source", "management"]) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.configured === "boolean" &&
    (value.source === undefined ||
      value.source === "local-api-key" ||
      value.source === "local-oauth" ||
      value.source === "sync-api-key" ||
      value.source === "conflict") &&
    (value.management === undefined || value.management === "local" || value.management === "sync")
  );
}

function isWebSearchProviderStatus(value: unknown): value is WebSearchProviderStatus {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "id",
      "name",
      "available",
      "source",
      "hasStoredCredential",
      "bestEffort",
    ]) &&
    isWebSearchProviderId(value.id) &&
    typeof value.name === "string" &&
    typeof value.available === "boolean" &&
    (value.source === undefined ||
      value.source === "environment" ||
      value.source === "stored" ||
      value.source === "sync") &&
    typeof value.hasStoredCredential === "boolean" &&
    typeof value.bestEffort === "boolean"
  );
}

function isWebToolsStatus(value: unknown): value is WebToolsStatus {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "primary",
      "effectiveOrder",
      "providers",
      "settingsSource",
      "credentialSource",
    ]) &&
    isWebSearchPrimary(value.primary) &&
    (value.settingsSource === undefined ||
      value.settingsSource === "local" ||
      value.settingsSource === "sync") &&
    (value.credentialSource === undefined ||
      value.credentialSource === "local" ||
      value.credentialSource === "sync") &&
    Array.isArray(value.effectiveOrder) &&
    value.effectiveOrder.every(isWebSearchProviderId) &&
    Array.isArray(value.providers) &&
    value.providers.every(isWebSearchProviderStatus)
  );
}

/** Validate a message received by a client before dispatching it to UI code. */
// The switch is intentionally exhaustive at this trust boundary.
// oxlint-disable-next-line complexity
export function parseServerMessage(raw: unknown): ServerMessage | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  switch (raw.type) {
    case "core_hello": {
      if (
        !hasOnlyKeys(raw, ["type", "productVersion", "revision", "protocolVersion", "capabilities"])
      ) {
        return undefined;
      }
      const hello = parseCoreHello({
        productVersion: raw.productVersion,
        revision: raw.revision,
        protocolVersion: raw.protocolVersion,
        capabilities: raw.capabilities,
      });
      return hello ? { type: "core_hello", ...hello } : undefined;
    }
    case "snapshot":
      if (typeof raw.cwd !== "string" || typeof raw.sessionId !== "string") {
        return undefined;
      }
      if (raw.model !== undefined && !isModelRef(raw.model)) {
        return undefined;
      }
      const parsedSnapshot = parseSnapshot(raw.snapshot);
      if (!parsedSnapshot) {
        return undefined;
      }
      return parsedSnapshot === raw.snapshot
        ? (raw as ServerMessage)
        : ({ ...raw, snapshot: parsedSnapshot } as ServerMessage);
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
    case "web_tools_status":
      return hasOnlyKeys(raw, ["type", "status", "error"]) &&
        isWebToolsStatus(raw.status) &&
        (raw.error === undefined || typeof raw.error === "string")
        ? (raw as ServerMessage)
        : undefined;
    case "drafts_recovered":
      return hasOnlyKeys(raw, ["type", "drafts"]) &&
        Array.isArray(raw.drafts) &&
        raw.drafts.every(isRecoveredDraft)
        ? (raw as ServerMessage)
        : undefined;
    case "skill_listing":
      return hasOnlyKeys(raw, ["type", "sessionId", "skills"]) &&
        typeof raw.sessionId === "string" &&
        Array.isArray(raw.skills) &&
        raw.skills.every(isSkillCommand)
        ? (raw as ServerMessage)
        : undefined;
    case "project_trust_requested":
      return hasOnlyKeys(raw, ["type", "requestId", "cwd", "resources"]) &&
        typeof raw.requestId === "string" &&
        typeof raw.cwd === "string" &&
        isStringArray(raw.resources)
        ? (raw as ServerMessage)
        : undefined;
    case "core_identity":
      return typeof raw.name === "string" ? (raw as ServerMessage) : undefined;
    default:
      return undefined;
  }
}
