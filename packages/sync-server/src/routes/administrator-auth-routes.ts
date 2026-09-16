import type { IncomingMessage, ServerResponse } from "node:http";
import {
  SYNC_ROUTES,
  type SyncErrorCode,
  parseAdministratorLoginRequest,
  parseAdministratorSetupRequest,
} from "@cinba/sync-contract";
import type {
  AdministratorAuthService,
  AuthenticationFailure,
  RequestSecurity,
} from "../services/administrator-auth.ts";

const MAX_AUTH_BODY_BYTES = 16 * 1024;

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function errorCode(failure: AuthenticationFailure): SyncErrorCode {
  if (failure.code === "invalid_request") {
    return "bad_request";
  }
  return failure.code;
}

function sendFailure(response: ServerResponse, result: AuthenticationFailure): void {
  const code = errorCode(result);
  json(response, result.status, {
    version: 1,
    error: {
      code,
      message: `Administrator authentication failed (${code})`,
      retryable: code === "rate_limited",
    },
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const mediaType = (request.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new Error("request content type must be JSON");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > MAX_AUTH_BODY_BYTES) {
      throw new Error("request body is too large");
    }
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function security(request: IncomingMessage): RequestSecurity {
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

/** Handle only administrator-auth routes so later management routes can compose around it. */
export function createAdministratorAuthHandler(service: AdministratorAuthService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const authPaths = new Set<string>([
      SYNC_ROUTES.management.authStatus,
      SYNC_ROUTES.management.setup,
      SYNC_ROUTES.management.login,
      SYNC_ROUTES.management.logout,
    ]);
    if (!authPaths.has(path)) {
      return false;
    }

    try {
      if (path === SYNC_ROUTES.management.authStatus && request.method === "GET") {
        json(response, 200, service.status(request.headers.cookie));
        return true;
      }
      if (path === SYNC_ROUTES.management.setup && request.method === "POST") {
        const body = parseAdministratorSetupRequest(await readJson(request));
        const result = await service.setup(body.setupCode, body.password, security(request));
        if (!result.ok) {
          sendFailure(response, result);
        } else {
          json(response, 200, result.body, { "Set-Cookie": result.setCookie });
        }
        return true;
      }
      if (path === SYNC_ROUTES.management.login && request.method === "POST") {
        const body = parseAdministratorLoginRequest(await readJson(request));
        const result = service.login(body.password, security(request));
        if (!result.ok) {
          sendFailure(response, result);
        } else {
          json(response, 200, result.body, { "Set-Cookie": result.setCookie });
        }
        return true;
      }
      if (path === SYNC_ROUTES.management.logout && request.method === "POST") {
        const result = service.logout(security(request));
        if (!result.ok) {
          sendFailure(response, result);
        } else {
          json(response, 200, { version: 1, state: "ready" }, { "Set-Cookie": result.setCookie });
        }
        return true;
      }
      json(response, 405, {
        version: 1,
        error: {
          code: "bad_request",
          message: "Method not allowed",
          retryable: false,
        },
      });
    } catch {
      json(response, 400, {
        version: 1,
        error: {
          code: "bad_request",
          message: "Administrator authentication request is invalid",
          retryable: false,
        },
      });
    }
    return true;
  };
}
