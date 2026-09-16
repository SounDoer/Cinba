import { existsSync, unlinkSync } from "node:fs";
import { type StoredJsonError, loadStoredJson, writeAtomicJson } from "../atomic-json-store.ts";
import type { CredentialSource, SettingsSource, SourceSelection } from "../effective-settings.ts";

export type PendingSyncEnrollment = {
  id: string;
  secret: string;
  expiresAt: string;
};

export type ConnectedSyncCore = {
  id: string;
  credential: string;
};

export type SyncConnection = {
  version: 1;
  serverUrl: string;
  sources: SourceSelection;
  pending?: PendingSyncEnrollment;
  core?: ConnectedSyncCore;
};

export type SyncConnectionStore = {
  get(): SyncConnection | undefined;
  begin(options: {
    serverUrl: string;
    sources: SourceSelection;
    enrollment: PendingSyncEnrollment;
  }): void;
  approve(core: ConnectedSyncCore): void;
  disconnect(): void;
  problem(): StoredJsonError | undefined;
};

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function source(value: unknown, name: string): SettingsSource | CredentialSource {
  if (value !== "local" && value !== "sync") {
    throw new Error(`${name} has an unsupported source`);
  }
  return value;
}

function parseConnection(value: unknown): SyncConnection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a Sync connection object");
  }
  const document = value as Record<string, unknown>;
  const allowed = new Set(["version", "serverUrl", "sources", "pending", "core"]);
  if (Object.keys(document).some((key) => !allowed.has(key)) || document.version !== 1) {
    throw new Error("unsupported Sync connection document");
  }
  const serverUrl = new URL(requiredString(document.serverUrl, "serverUrl"));
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(serverUrl.hostname.toLowerCase());
  if (
    serverUrl.origin !== document.serverUrl ||
    (serverUrl.protocol !== "https:" && !(serverUrl.protocol === "http:" && loopback))
  ) {
    throw new Error("serverUrl must be an HTTPS or loopback development origin");
  }
  if (typeof document.sources !== "object" || document.sources === null) {
    throw new Error("sources must be an object");
  }
  const sources = document.sources as Record<string, unknown>;
  if (Object.keys(sources).some((key) => key !== "settings" && key !== "credentials")) {
    throw new Error("sources has unknown fields");
  }
  const settings = source(sources.settings, "settings") as SettingsSource;
  const credentials = source(sources.credentials, "credentials") as CredentialSource;
  if (settings === "local" && credentials === "sync") {
    throw new Error("Local Settings cannot use Shared Credentials");
  }
  const pending = document.pending as Record<string, unknown> | undefined;
  const core = document.core as Record<string, unknown> | undefined;
  if ((pending === undefined) === (core === undefined)) {
    throw new Error("connection must be pending or approved");
  }
  if (
    (pending && Object.keys(pending).some((key) => !["id", "secret", "expiresAt"].includes(key))) ||
    (core && Object.keys(core).some((key) => !["id", "credential"].includes(key)))
  ) {
    throw new Error("connection credential record has unknown fields");
  }
  return {
    version: 1,
    serverUrl: serverUrl.origin,
    sources: { settings, credentials },
    ...(pending
      ? {
          pending: {
            id: requiredString(pending.id, "pending.id"),
            secret: requiredString(pending.secret, "pending.secret"),
            expiresAt: requiredString(pending.expiresAt, "pending.expiresAt"),
          },
        }
      : {}),
    ...(core
      ? {
          core: {
            id: requiredString(core.id, "core.id"),
            credential: requiredString(core.credential, "core.credential"),
          },
        }
      : {}),
  };
}

function clone(connection: SyncConnection | undefined): SyncConnection | undefined {
  return connection ? structuredClone(connection) : undefined;
}

export function createSyncConnectionStore(path: string): SyncConnectionStore {
  const loaded = loadStoredJson(path, parseConnection);
  let connection = loaded.status === "valid" ? loaded.value : undefined;
  const loadProblem = loaded.status === "invalid" ? loaded.error : undefined;

  function commit(next: SyncConnection): void {
    if (loadProblem) {
      throw loadProblem;
    }
    writeAtomicJson(path, next, parseConnection);
    connection = next;
  }

  return {
    get: () => clone(connection),
    begin: ({ serverUrl, sources, enrollment }) =>
      commit(parseConnection({ version: 1, serverUrl, sources, pending: enrollment })),
    approve: (core) => {
      if (!connection?.pending) {
        throw new Error("No pending Sync enrollment exists");
      }
      commit({
        version: 1,
        serverUrl: connection.serverUrl,
        sources: { ...connection.sources },
        core: { ...core },
      });
    },
    disconnect: () => {
      if (loadProblem) {
        throw loadProblem;
      }
      if (existsSync(path)) {
        unlinkSync(path);
      }
      connection = undefined;
    },
    problem: () => loadProblem,
  };
}
