// Public entry point for clients that connect to a running Cinba Core.

export { CoreClient } from "./core-client.ts";
export {
  requestLocalCoreLifetime,
  requestLocalCoreStatus,
  requestLocalCoreStop,
} from "./core-control.ts";
export { probeCoreHealth } from "./core-health.ts";
export type {
  CoreClientHandlers,
  CoreClientOptions,
  CoreConnectionState,
  ReconnectScheduler,
  SnapshotState,
  Socket,
  SocketFactory,
} from "./core-client.ts";
export type { CoreHealth, HealthFetcher, HealthResponse } from "./core-health.ts";
export type { LocalCoreControlStatus } from "./core-control.ts";
