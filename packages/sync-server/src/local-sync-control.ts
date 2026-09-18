import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type LocalSyncControlHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => boolean;

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

/** Local-only lifecycle controls, enabled solely for a manager token-bearing Sync process. */
export function createLocalSyncControlHandler(options: {
  token: string | undefined;
  snapshot: () => { activeRequestCount: number; draining: boolean };
  beginStop: () => boolean;
  requestStop: () => void;
  schedule?: (callback: () => void) => void;
}): LocalSyncControlHandler {
  const enabled = Boolean(options.token);
  const schedule = options.schedule ?? setImmediate;
  return (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (!enabled || (path !== "/local-sync/status" && path !== "/local-sync/stop")) {
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
