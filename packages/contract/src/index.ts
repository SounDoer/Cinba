// The contract: what the service and its interfaces agree on.
//
// Nothing here knows Pi exists, and nothing here depends on anything. That is
// the point — a browser imports this, and so does the service, and so does the
// terminal. Whatever both ends must agree on lives here; whatever only one end
// does lives with that end.

export { COMMANDS, commandArgument, isCommand, matchCommands } from "./commands.ts";
export type { Command, CommandId } from "./commands.ts";
export type { ToolStatus, ViewAction } from "./actions.ts";
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
  ModelRef,
  ProviderStatus,
  ServerMessage,
  SessionSummary,
} from "./protocol.ts";
export { RemoteSession } from "./remote.ts";
export type { RemoteHandlers, SnapshotState, Socket } from "./remote.ts";
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
