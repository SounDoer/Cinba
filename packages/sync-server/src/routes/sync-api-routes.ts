import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  SYNC_ROUTES,
  type SyncErrorCode,
  parseCapabilitiesReport,
  parseCorePreferencesRequest,
  parseEnrollmentDecisionRequest,
  parseEnrollmentRequest,
  parsePutCredentialRequest,
  parseRollbackSettingsRequest,
  parseUpdateSharedSettingsRequest,
} from "@cinba/sync-contract";
import type {
  AdministratorAuthService,
  AuthenticationFailure,
} from "../services/administrator-auth.ts";
import {
  CoreAuthenticationError,
  EnrollmentAuthenticationError,
  SettingsConflictError,
  SyncMaintenanceError,
  type SyncStore,
} from "../store/sync-store.ts";
import { createAdministratorAuthHandler } from "./administrator-auth-routes.ts";

const MAX_BODY_BYTES = 64 * 1024;

export type SyncAccessLog = {
  requestId: string;
  route: string;
  status: number;
};

function routeName(path: string): string {
  if (path.startsWith(`${SYNC_ROUTES.management.credentials}/`)) {
    return `${SYNC_ROUTES.management.credentials}/:provider`;
  }
  if (path.startsWith(`${SYNC_ROUTES.management.enrollments}/`)) {
    return `${SYNC_ROUTES.management.enrollments}/:id`;
  }
  if (path.startsWith(`${SYNC_ROUTES.management.cores}/`) && path.endsWith("/revoke")) {
    return `${SYNC_ROUTES.management.cores}/:id/revoke`;
  }
  if (path.startsWith(`${SYNC_ROUTES.core.enrollments}/`)) {
    return `${SYNC_ROUTES.core.enrollments}/:id`;
  }
  return path;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function sendError(
  response: ServerResponse,
  status: number,
  code: SyncErrorCode,
  retryable = false,
): void {
  sendJson(response, status, {
    version: 1,
    error: {
      code,
      message: `Sync request failed (${code})`,
      retryable,
    },
  });
}

function sendAuthenticationFailure(response: ServerResponse, result: AuthenticationFailure): void {
  const code: SyncErrorCode = result.code === "invalid_request" ? "bad_request" : result.code;
  sendError(response, result.status, code, code === "rate_limited");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const mediaType = (request.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new Error("expected JSON");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new Error("request too large");
    }
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function bearer(request: IncomingMessage, scheme: "Bearer" | "Enrollment"): string | undefined {
  const header = request.headers.authorization;
  const prefix = `${scheme} `;
  return header?.startsWith(prefix) ? header.slice(prefix.length) : undefined;
}

function requestSecurity(request: IncomingMessage) {
  return {
    origin: request.headers.origin,
    cookie: request.headers.cookie,
    csrfToken:
      typeof request.headers["x-cinba-csrf"] === "string"
        ? request.headers["x-cinba-csrf"]
        : undefined,
    clientKey: request.socket.remoteAddress ?? "unknown-client",
  };
}

function pathTail(path: string, prefix: string, suffix = ""): string | undefined {
  if (!path.startsWith(`${prefix}/`) || (suffix && !path.endsWith(suffix))) {
    return undefined;
  }
  const end = suffix ? -suffix.length : undefined;
  const value = path.slice(prefix.length + 1, end);
  if (!value || value.includes("/")) {
    return undefined;
  }
  return decodeURIComponent(value);
}

async function handleCoreRoute(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  store: SyncStore,
): Promise<boolean> {
  if (path === SYNC_ROUTES.core.enrollments && request.method === "POST") {
    const created = await store.createEnrollment(parseEnrollmentRequest(await readJson(request)));
    sendJson(response, 201, created);
    return true;
  }
  const enrollmentId = pathTail(path, SYNC_ROUTES.core.enrollments);
  if (enrollmentId && request.method === "GET") {
    const secret = bearer(request, "Enrollment");
    if (!secret) {
      sendError(response, 401, "unauthorized");
      return true;
    }
    sendJson(response, 200, await store.enrollmentStatus(enrollmentId, secret));
    return true;
  }
  if (path === SYNC_ROUTES.core.snapshot && request.method === "GET") {
    const credential = bearer(request, "Bearer");
    if (!credential) {
      sendError(response, 401, "unauthorized");
      return true;
    }
    const snapshot = await store.snapshotForCore(credential);
    const etag = `"sync-${snapshot.syncRevision}"`;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { "Cache-Control": "no-store", ETag: etag }).end();
      return true;
    }
    response.setHeader("ETag", etag);
    sendJson(response, 200, snapshot);
    return true;
  }
  if (path === SYNC_ROUTES.core.capabilities && request.method === "PUT") {
    const credential = bearer(request, "Bearer");
    if (!credential) {
      sendError(response, 401, "unauthorized");
      return true;
    }
    await store.reportCapabilities(credential, parseCapabilitiesReport(await readJson(request)));
    sendJson(response, 200, { version: 1, accepted: true });
    return true;
  }
  if (path === SYNC_ROUTES.core.preferences && request.method === "PUT") {
    const credential = bearer(request, "Bearer");
    if (!credential) {
      sendError(response, 401, "unauthorized");
      return true;
    }
    const preferences = parseCorePreferencesRequest(await readJson(request));
    await store.updateCoreCredentialSource(credential, preferences.credentialSource);
    sendJson(response, 200, { version: 1, accepted: true });
    return true;
  }
  return false;
}

function handleManagementSummaryRoute(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  store: SyncStore,
  requireRead: () => boolean,
): boolean {
  if (path === SYNC_ROUTES.management.overview && request.method === "GET") {
    if (!requireRead()) {
      return true;
    }
    const settings = store.settings();
    const cores = store.connectedCores().cores;
    sendJson(response, 200, {
      version: 1,
      serverId: store.serverId(),
      settingsRevision: settings.settingsRevision,
      syncRevision: settings.syncRevision,
      connectedCoreCount: cores.filter((core) => !core.revoked).length,
      pendingEnrollmentCount: store.pendingEnrollments().enrollments.length,
      recentSyncErrors: cores
        .filter((core) => !core.revoked && core.lastSyncErrorCode)
        .map((core) => ({
          coreId: core.id,
          coreName: core.name,
          code: core.lastSyncErrorCode,
        })),
    });
    return true;
  }
  if (path === SYNC_ROUTES.management.backupMetadata && request.method === "GET") {
    if (!requireRead()) {
      return true;
    }
    const settings = store.settings();
    const history = store.history();
    sendJson(response, 200, {
      version: 1,
      serverId: store.serverId(),
      createdAt: history.at(-1)?.createdAt ?? new Date(0).toISOString(),
      settingsRevision: settings.settingsRevision,
      syncRevision: settings.syncRevision,
      connectedCoreCount: store.connectedCores().cores.filter((core) => !core.revoked).length,
      credentialCount: store.credentialStatuses().length,
    });
    return true;
  }
  return false;
}

export function createSyncApiHandler(options: {
  store: SyncStore;
  administrator: AdministratorAuthService;
  log?: (entry: SyncAccessLog) => void;
}) {
  const authHandler = createAdministratorAuthHandler(options.administrator);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestId = randomUUID();
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    response.once("finish", () => {
      options.log?.({ requestId, route: routeName(path), status: response.statusCode });
    });
    if (await authHandler(request, response)) {
      return;
    }

    const requireRead = (): boolean => {
      const result = options.administrator.authorizeRead(request.headers.cookie);
      if (!result.ok) {
        sendAuthenticationFailure(response, result);
        return false;
      }
      return true;
    };
    const requireWrite = (): boolean => {
      const result = options.administrator.authorizeWrite(requestSecurity(request));
      if (!result.ok) {
        sendAuthenticationFailure(response, result);
        return false;
      }
      return true;
    };

    try {
      if (await handleCoreRoute(path, request, response, options.store)) {
        return;
      }
      if (handleManagementSummaryRoute(path, request, response, options.store, requireRead)) {
        return;
      }

      if (path === SYNC_ROUTES.management.settings && request.method === "GET") {
        if (!requireRead()) {
          return;
        }
        sendJson(response, 200, options.store.settings());
        return;
      }
      if (path === SYNC_ROUTES.management.settings && request.method === "PUT") {
        if (!requireWrite()) {
          return;
        }
        const update = parseUpdateSharedSettingsRequest(await readJson(request));
        sendJson(
          response,
          200,
          await options.store.updateSettings(update.baseSettingsRevision, update.settings),
        );
        return;
      }
      if (path === SYNC_ROUTES.management.credentials && request.method === "GET") {
        if (!requireRead()) {
          return;
        }
        sendJson(response, 200, {
          version: 1,
          credentials: options.store.credentialStatuses(),
          syncRevision: options.store.settings().syncRevision,
        });
        return;
      }
      const provider = pathTail(path, SYNC_ROUTES.management.credentials);
      if (provider && request.method === "PUT") {
        if (!requireWrite()) {
          return;
        }
        const update = parsePutCredentialRequest(await readJson(request));
        const syncRevision = await options.store.setCredential(provider, update.apiKey);
        sendJson(response, 200, {
          version: 1,
          credentials: options.store.credentialStatuses(),
          syncRevision,
        });
        return;
      }
      if (provider && request.method === "DELETE") {
        if (!requireWrite()) {
          return;
        }
        const syncRevision = await options.store.setCredential(provider, undefined);
        sendJson(response, 200, {
          version: 1,
          credentials: options.store.credentialStatuses(),
          syncRevision,
        });
        return;
      }
      if (path === SYNC_ROUTES.management.cores && request.method === "GET") {
        if (!requireRead()) {
          return;
        }
        sendJson(response, 200, options.store.connectedCores());
        return;
      }
      const revokeCoreId = pathTail(path, SYNC_ROUTES.management.cores, "/revoke");
      if (revokeCoreId && request.method === "POST") {
        if (!requireWrite()) {
          return;
        }
        await options.store.revokeCore(revokeCoreId);
        sendJson(response, 200, options.store.connectedCores());
        return;
      }
      if (path === SYNC_ROUTES.management.enrollments && request.method === "GET") {
        if (!requireRead()) {
          return;
        }
        sendJson(response, 200, options.store.pendingEnrollments());
        return;
      }
      const managedEnrollmentId = pathTail(path, SYNC_ROUTES.management.enrollments);
      if (managedEnrollmentId && request.method === "POST") {
        if (!requireWrite()) {
          return;
        }
        const decision = parseEnrollmentDecisionRequest(await readJson(request));
        await options.store.decideEnrollment(managedEnrollmentId, decision.decision);
        sendJson(response, 200, options.store.connectedCores());
        return;
      }
      if (path === SYNC_ROUTES.management.models && request.method === "GET") {
        if (!requireRead()) {
          return;
        }
        sendJson(response, 200, options.store.modelCatalog());
        return;
      }
      if (path === SYNC_ROUTES.management.history && request.method === "GET") {
        if (!requireRead()) {
          return;
        }
        sendJson(response, 200, {
          version: 1,
          entries: options.store.history().map((entry) => ({ version: 1, ...entry })),
        });
        return;
      }
      if (path === SYNC_ROUTES.management.rollback && request.method === "POST") {
        if (!requireWrite()) {
          return;
        }
        const rollback = parseRollbackSettingsRequest(await readJson(request));
        sendJson(
          response,
          200,
          await options.store.rollbackSettings(
            rollback.baseSettingsRevision,
            rollback.targetSettingsRevision,
          ),
        );
        return;
      }
      sendError(response, 404, "not_found");
    } catch (error) {
      if (
        error instanceof CoreAuthenticationError ||
        error instanceof EnrollmentAuthenticationError
      ) {
        sendError(response, 401, "unauthorized");
      } else if (error instanceof SettingsConflictError) {
        sendError(response, 409, "conflict");
      } else if (error instanceof SyncMaintenanceError) {
        sendError(response, 503, "unavailable", true);
      } else {
        sendError(response, 400, "bad_request");
      }
    }
  };
}
