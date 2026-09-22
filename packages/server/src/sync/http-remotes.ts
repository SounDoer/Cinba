import {
  CoreSyncClient,
  EnrollmentClient,
  SyncClientError,
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

export type CoreLifecycleRemote = {
  revoke(signal?: AbortSignal): Promise<unknown>;
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
): SnapshotRemote & CapabilitiesRemote & CorePreferencesRemote & CoreLifecycleRemote {
  return new CoreSyncClient(http(serverUrl), coreAuthorization(credential));
}

export async function revokeCoreSyncAccess(
  serverUrl: string,
  credential: string,
  remoteFor: (
    serverUrl: string,
    credential: string,
  ) => CoreLifecycleRemote = createCoreSyncHttpRemote,
): Promise<void> {
  try {
    await remoteFor(serverUrl, credential).revoke();
  } catch (error) {
    // A rejected credential means this Core no longer has server-side access.
    if (!(error instanceof SyncClientError && error.status === 401)) {
      throw error;
    }
  }
}
