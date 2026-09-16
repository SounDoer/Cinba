import {
  CoreSyncClient,
  EnrollmentClient,
  SyncHttpClient,
  coreAuthorization,
  enrollmentAuthorization,
} from "@cinba/sync-client";
import type { CapabilitiesRemote } from "./capabilities-reporter.ts";
import type { SnapshotRemote } from "./coordinator.ts";
import type { EnrollmentRemote } from "./enrollment-coordinator.ts";

export type CorePreferencesRemote = {
  updateCredentialSource(source: "local" | "sync", signal?: AbortSignal): Promise<unknown>;
};

function http(serverUrl: string): SyncHttpClient {
  return new SyncHttpClient(serverUrl, { allowInsecureLoopback: serverUrl.startsWith("http:") });
}

export function createEnrollmentHttpRemote(serverUrl: string): EnrollmentRemote {
  const client = new EnrollmentClient(http(serverUrl));
  return {
    create: (request, signal) => client.create(request, signal),
    status: (id, secret, signal) => client.status(id, enrollmentAuthorization(secret), signal),
  };
}

export function createCoreSyncHttpRemote(
  serverUrl: string,
  credential: string,
): SnapshotRemote & CapabilitiesRemote & CorePreferencesRemote {
  return new CoreSyncClient(http(serverUrl), coreAuthorization(credential));
}
