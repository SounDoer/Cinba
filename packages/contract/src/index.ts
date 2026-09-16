// The contract: what the service and its interfaces agree on.
//
// Nothing here knows Pi exists, and nothing here depends on anything. That is
// the point — a browser imports this, and so does the service, and so does the
// terminal. Whatever both ends must agree on lives here; whatever only one end
// does lives with that end.

export { COMMANDS, commandArgument, isCommand, matchCommands } from "./commands.ts";
export type { Command, CommandId, SkillCommand, SkillScope, SlashCommand } from "./commands.ts";
export type {
  AutoRetry,
  ContextUsage,
  PendingMessages,
  ToolStatus,
  ViewAction,
} from "./actions.ts";
export { agentActivity } from "./activity.ts";
export type { AgentActivity } from "./activity.ts";
export {
  NAME_COLOURS,
  nameColourIndex,
  projectName,
  sessionSubtitle,
  sessionTitle,
} from "./labels.ts";
export { parseClientMessage, parseServerMessage } from "./protocol.ts";
export type {
  ClientMessage,
  PromptStreamingBehavior,
  RecoveredDraft,
  ModelRef,
  ProviderStatus,
  ServerMessage,
  SessionSummary,
  WebSearchCredentialProviderId,
  WebSearchCredentialSource,
  WebSearchPrimary,
  WebSearchProviderId,
  WebSearchProviderStatus,
  WebToolsConfigurationSource,
  WebToolsStatus,
} from "./protocol.ts";
export { createSession, sameTranscript } from "./session.ts";
export type {
  Entry,
  MessageEntry,
  ModelEntry,
  NoticeEntry,
  Session,
  Snapshot,
  ToolEntry,
} from "./session.ts";
export { isThinkingLevel, THINKING_LEVELS } from "./thinking.ts";
export type { ThinkingLevel, ThinkingState } from "./thinking.ts";
export {
  CORE_SYNC_ROUTES,
  parseConnectCoreSyncRequest,
  parseCoreSyncOperationAccepted,
  parseCoreSyncSources,
  parseCoreSyncView,
  parseUpdateCoreInstanceOverrideRequest,
  parseUpdateCoreSyncSourcesRequest,
} from "./sync.ts";
export type {
  ConnectCoreSyncRequest,
  CoreInstanceOverride,
  CoreSyncOperationAccepted,
  CoreSyncSettings,
  CoreSyncSources,
  CoreSyncState,
  CoreSyncView,
  SyncCredentialSource,
  SyncSettingsSource,
  UpdateCoreInstanceOverrideRequest,
  UpdateCoreSyncSourcesRequest,
} from "./sync.ts";
