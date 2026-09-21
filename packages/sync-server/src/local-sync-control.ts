import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type SharedSettings, parseSharedSettings } from "@cinba/sync-contract";

const MAX_BODY_BYTES = 32 * 1024;
const LOCAL_SYNC_CONTROL_PATHS = new Set([
  "/local-sync/status",
  "/local-sync/stop",
  "/local-sync/host-status",
  "/local-sync/setup-code",
  "/local-sync/bootstrap",
]);

export type LocalSyncControlHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean>;

export type LocalSyncHostStatus = {
  status: "ok";
  serverId: string;
  setupState: "setup-required" | "ready";
  settingsRevision: number;
  syncRevision: number;
  connectedCoreCount: number;
  pendingEnrollmentCount: number;
};

export type LocalSyncHostBootstrapRequest = {
  enrollmentId: string;
  enrollmentSecret: string;
  settings: SharedSettings;
};

export type LocalSyncHostBootstrapResult = {
  serverId: string;
  coreId: string;
  settingsRevision: number;
  syncRevision: number;
};

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) {
    return false;
  }
  const received = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response
    .writeHead(statusCode, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    })
    .end(JSON.stringify(body));
}

function boundedString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`${name} must be a bounded non-empty string`);
  }
  return value;
}

async function readBootstrapRequest(
  request: IncomingMessage,
): Promise<LocalSyncHostBootstrapRequest> {
  if (
    request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    throw new Error("Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      throw new Error("Request body is too large");
    }
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Bootstrap request must be an object");
  }
  const parsed = value as Record<string, unknown>;
  if (
    Object.keys(parsed).length !== 3 ||
    !("enrollmentId" in parsed) ||
    !("enrollmentSecret" in parsed) ||
    !("settings" in parsed)
  ) {
    throw new Error("Bootstrap request has unexpected or missing fields");
  }
  return {
    enrollmentId: boundedString(parsed.enrollmentId, "enrollmentId"),
    enrollmentSecret: boundedString(parsed.enrollmentSecret, "enrollmentSecret"),
    settings: parseSharedSettings(parsed.settings),
  };
}

/** Local-only lifecycle controls, enabled solely for a manager token-bearing Sync process. */
export function createLocalSyncControlHandler(options: {
  token: string | undefined;
  snapshot: () => { activeRequestCount: number; draining: boolean };
  beginStop: () => boolean;
  requestStop: () => void;
  hostStatus?: () => Omit<LocalSyncHostStatus, "status">;
  setupCode?: () => string | undefined;
  bootstrap?: (request: LocalSyncHostBootstrapRequest) => Promise<LocalSyncHostBootstrapResult>;
  schedule?: (callback: () => void) => void;
}): LocalSyncControlHandler {
  const enabled = Boolean(options.token);
  const schedule = options.schedule ?? setImmediate;
  return async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (!enabled || !LOCAL_SYNC_CONTROL_PATHS.has(path)) {
      return false;
    }
    if (!tokenMatches(request.headers.authorization, options.token!)) {
      sendJson(response, 401, { status: "unauthorized" });
      return true;
    }
    if (path === "/local-sync/status") {
      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET" }).end();
        return true;
      }
      const snapshot = options.snapshot();
      sendJson(response, 200, {
        status: "ok",
        pid: process.pid,
        activeRequestCount: snapshot.activeRequestCount,
        safeToStop: snapshot.activeRequestCount === 0 && !snapshot.draining,
        draining: snapshot.draining,
      });
      return true;
    }
    if (path === "/local-sync/host-status") {
      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET" }).end();
        return true;
      }
      if (!options.hostStatus) {
        response.writeHead(404, { "cache-control": "no-store" }).end();
        return true;
      }
      sendJson(response, 200, { status: "ok", ...options.hostStatus() });
      return true;
    }
    if (path === "/local-sync/setup-code") {
      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET" }).end();
        return true;
      }
      const setupCode = options.setupCode?.();
      if (!setupCode) {
        sendJson(response, 409, { status: "setup-complete" });
        return true;
      }
      sendJson(response, 200, { status: "ok", setupCode });
      return true;
    }
    if (path === "/local-sync/bootstrap") {
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST" }).end();
        return true;
      }
      if (!options.bootstrap) {
        response.writeHead(404, { "cache-control": "no-store" }).end();
        return true;
      }
      let bootstrapRequest: LocalSyncHostBootstrapRequest;
      try {
        bootstrapRequest = await readBootstrapRequest(request);
      } catch {
        sendJson(response, 400, { status: "invalid-request" });
        return true;
      }
      try {
        sendJson(response, 200, {
          status: "ok",
          ...(await options.bootstrap(bootstrapRequest)),
        });
      } catch {
        sendJson(response, 409, { status: "bootstrap-refused" });
      }
      return true;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end();
      return true;
    }
    if (!options.beginStop()) {
      sendJson(response, 409, {
        status: "busy",
        activeRequestCount: options.snapshot().activeRequestCount,
      });
      return true;
    }
    sendJson(response, 202, { status: "accepted" });
    schedule(options.requestStop);
    return true;
  };
}
