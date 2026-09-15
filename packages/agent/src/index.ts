// Everything that touches Pi.
//
// Nothing here is imported by a frontend: a frontend that needed any of it
// would be reaching past the service into the core.

export { clearCredential, listProviders, setApiKey } from "./credentials.ts";
export { PiClient } from "./pi-client.ts";
export type { CoreEvent, CoreResponse, UiReply, UiRequest, UiRequestHandler } from "./pi-client.ts";
export { activeBranchEntries, foldSessionEntries } from "./entries.ts";
export { createEventFolder, foldUiRequest } from "./events.ts";
export { buildSpawnPlan, startPi } from "./pi-process.ts";
export type { CoreOptions, SpawnPlan } from "./pi-process.ts";
export { inspectProjectTrust, rememberProjectTrust } from "./project-trust.ts";
export type { ProjectTrustInspection } from "./project-trust.ts";
export { findSession, listSessions } from "./stored-sessions.ts";
export type { StoredSession } from "./stored-sessions.ts";
export { StdioTransport } from "./transport.ts";
export type { Transport } from "./transport.ts";
