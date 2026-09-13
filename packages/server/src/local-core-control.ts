import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CoreLifetime } from "./service-idle.ts";

export type LocalCoreControlSnapshot = {
  status: "ok";
  lifetime: "on-demand";
  pid: number;
  clientCount: number;
  safeToStop: boolean;
  draining: boolean;
};

export type LocalCoreControlHandler = (
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

/** Local-only lifecycle controls, enabled solely for a token-bearing on-demand Core. */
export function createLocalCoreControlHandler(options: {
  lifetime: CoreLifetime;
  token: string | undefined;
  snapshot: () => Omit<LocalCoreControlSnapshot, "status" | "lifetime" | "pid">;
  requestStop: () => void;
  schedule?: (callback: () => void) => void;
}): LocalCoreControlHandler {
  const enabled = options.lifetime === "on-demand" && Boolean(options.token);
  const schedule = options.schedule ?? setImmediate;

  return (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (!enabled || (path !== "/local-core/status" && path !== "/local-core/stop")) {
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
        lifetime: "on-demand",
        pid: process.pid,
        ...options.snapshot(),
      } satisfies LocalCoreControlSnapshot);
      return true;
    }

    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end();
      return true;
    }
    sendJson(response, 202, { status: "accepted" });
    schedule(options.requestStop);
    return true;
  };
}
