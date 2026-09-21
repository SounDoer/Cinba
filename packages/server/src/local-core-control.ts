import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CoreSyncSettings } from "@cinba/contract";
import type { CoreLifetime } from "./service-idle.ts";

const MAX_BODY_BYTES = 8 * 1024;

export type LocalCoreControlSnapshot = {
  status: "ok";
  lifetime: CoreLifetime;
  pid: number;
  clientCount: number;
  safeToStop: boolean;
  draining: boolean;
};

export type LocalCoreControlHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean>;

export type LocalCoreSyncEnrollmentReceipt = {
  enrollmentId: string;
  enrollmentSecret: string;
  expiresAt: string;
  settings: CoreSyncSettings & { version: 1 };
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

async function readSyncServerUrl(request: IncomingMessage): Promise<string> {
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
    throw new Error("Sync enrollment request must be an object");
  }
  const parsed = value as Record<string, unknown>;
  if (
    Object.keys(parsed).length !== 1 ||
    typeof parsed.serverUrl !== "string" ||
    parsed.serverUrl.length === 0 ||
    parsed.serverUrl.length > 2_048
  ) {
    throw new Error("Sync enrollment request must contain only serverUrl");
  }
  return parsed.serverUrl;
}

/** Local-only lifecycle controls, enabled solely for a manager token-bearing Core. */
export function createLocalCoreControlHandler(options: {
  lifetime: () => CoreLifetime;
  token: string | undefined;
  snapshot: () => Omit<LocalCoreControlSnapshot, "status" | "lifetime" | "pid">;
  requestStop: () => void;
  setLifetime: (lifetime: CoreLifetime) => void;
  beginSyncEnrollment?: (serverUrl: string) => Promise<LocalCoreSyncEnrollmentReceipt>;
  prepareSyncHostDelete?: () => Promise<void>;
  schedule?: (callback: () => void) => void;
}): LocalCoreControlHandler {
  const enabled = Boolean(options.token);
  const schedule = options.schedule ?? setImmediate;

  return async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const requestedLifetime = path.startsWith("/local-core/lifetime/")
      ? path.slice("/local-core/lifetime/".length)
      : undefined;
    const lifetimeRequest =
      requestedLifetime === "persistent" || requestedLifetime === "on-demand"
        ? requestedLifetime
        : undefined;
    if (
      !enabled ||
      (path !== "/local-core/status" &&
        path !== "/local-core/stop" &&
        path !== "/local-core/sync-enrollment" &&
        path !== "/local-core/prepare-sync-host-delete" &&
        !lifetimeRequest)
    ) {
      return false;
    }
    if (!tokenMatches(request.headers.authorization, options.token!)) {
      sendJson(response, 401, { status: "unauthorized" });
      return true;
    }

    if (path === "/local-core/status") {
      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET" }).end();
        return true;
      }
      sendJson(response, 200, {
        status: "ok",
        lifetime: options.lifetime(),
        pid: process.pid,
        ...options.snapshot(),
      } satisfies LocalCoreControlSnapshot);
      return true;
    }

    if (path === "/local-core/sync-enrollment") {
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST" }).end();
        return true;
      }
      if (!options.beginSyncEnrollment) {
        response.writeHead(404, { "cache-control": "no-store" }).end();
        return true;
      }
      let serverUrl: string;
      try {
        serverUrl = await readSyncServerUrl(request);
      } catch {
        sendJson(response, 400, { status: "invalid-request" });
        return true;
      }
      try {
        sendJson(response, 200, {
          status: "ok",
          ...(await options.beginSyncEnrollment(serverUrl)),
        });
      } catch {
        sendJson(response, 409, { status: "enrollment-refused" });
      }
      return true;
    }

    if (path === "/local-core/prepare-sync-host-delete") {
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST" }).end();
        return true;
      }
      if (!options.prepareSyncHostDelete) {
        response.writeHead(404, { "cache-control": "no-store" }).end();
        return true;
      }
      try {
        await options.prepareSyncHostDelete();
        sendJson(response, 202, { status: "accepted" });
      } catch {
        sendJson(response, 409, { status: "delete-refused" });
      }
      return true;
    }

    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end();
      return true;
    }
    if (lifetimeRequest) {
      options.setLifetime(lifetimeRequest);
      sendJson(response, 202, { status: "accepted", lifetime: lifetimeRequest });
      return true;
    }
    sendJson(response, 202, { status: "accepted" });
    schedule(options.requestStop);
    return true;
  };
}
