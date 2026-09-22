import type { EnrollmentCreated, EnrollmentRequest, EnrollmentStatus } from "@cinba/sync-contract";
import type { SourceSelection } from "../effective-settings.ts";
import { setTimeout as delay } from "node:timers/promises";
import type { SyncConnectionStore } from "./connection-store.ts";

export type EnrollmentRemote = {
  create(request: EnrollmentRequest, signal?: AbortSignal): Promise<EnrollmentCreated>;
  status(id: string, secret: string, signal?: AbortSignal): Promise<EnrollmentStatus>;
};

export type EnrollmentCoordinator = {
  begin(options: {
    serverUrl: string;
    sources: SourceSelection;
    request: EnrollmentRequest;
    signal?: AbortSignal;
  }): Promise<EnrollmentCreated>;
  poll(signal?: AbortSignal): Promise<EnrollmentStatus | undefined>;
  wait(signal?: AbortSignal): Promise<EnrollmentStatus | undefined>;
  cancel(): void;
};

export function createEnrollmentCoordinator(options: {
  store: SyncConnectionStore;
  remoteFor(serverUrl: string): EnrollmentRemote;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): EnrollmentCoordinator {
  let cancellation = new AbortController();
  let beginning = false;
  const sleep =
    options.sleep ??
    (async (milliseconds, signal) => {
      await delay(milliseconds, undefined, { signal });
    });
  const poll = async (signal?: AbortSignal): Promise<EnrollmentStatus | undefined> => {
    const connection = options.store.get();
    if (!connection?.pending) {
      return undefined;
    }
    const combined = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
    const result = await options
      .remoteFor(connection.serverUrl)
      .status(connection.pending.id, connection.pending.secret, combined);
    if (result.status === "approved") {
      options.store.approve({ id: result.coreId, credential: result.coreCredential });
    } else if (result.status === "rejected" || result.status === "expired") {
      options.store.disconnect();
    }
    return result;
  };

  return {
    begin: async ({ serverUrl, sources, request, signal }) => {
      if (beginning || options.store.get()) {
        throw new Error("A Sync connection already exists");
      }
      beginning = true;
      cancellation.abort();
      cancellation = new AbortController();
      try {
        const created = await options.remoteFor(serverUrl).create(request, signal);
        options.store.begin({
          serverUrl,
          sources,
          enrollment: {
            id: created.enrollmentId,
            secret: created.enrollmentSecret,
            expiresAt: created.expiresAt,
          },
        });
        return created;
      } finally {
        beginning = false;
      }
    },
    poll,
    wait: async (signal) => {
      const combined = signal
        ? AbortSignal.any([signal, cancellation.signal])
        : cancellation.signal;
      for (;;) {
        const result = await poll(combined);
        if (!result || result.status !== "pending") {
          return result;
        }
        await sleep(options.pollIntervalMs ?? 2_000, combined);
      }
    },
    cancel: () => {
      cancellation.abort();
      options.store.disconnect();
    },
  };
}
