import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CORE_SYNC_ROUTES,
  type CoreSyncOperationAccepted,
  type CoreSyncView,
  parseConnectCoreSyncRequest,
  parseUpdateCoreInstanceOverrideRequest,
  parseUpdateCoreSyncSourcesRequest,
} from "@cinba/contract";

const MAX_BODY_BYTES = 32 * 1024;

type Operations = {
  view(): CoreSyncView;
  connect(request: ReturnType<typeof parseConnectCoreSyncRequest>): Promise<void>;
  cancel(): void;
  disconnect(): void;
  syncNow(): Promise<void>;
  updateSources(request: ReturnType<typeof parseUpdateCoreSyncSourcesRequest>): Promise<void>;
  updateOverride(request: ReturnType<typeof parseUpdateCoreInstanceOverrideRequest>): void;
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response
    .writeHead(status, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    })
    .end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
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
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function isCrossSite(request: IncomingMessage): boolean {
  if (request.headers["sec-fetch-site"] === "cross-site") {
    return true;
  }
  const origin = request.headers.origin;
  if (!origin) {
    return false;
  }
  try {
    return new URL(origin).host !== request.headers.host;
  } catch {
    return true;
  }
}

const ACCEPTED: CoreSyncOperationAccepted = { version: 1, accepted: true };

/** Current-Core Sync controls. This API never accepts administrator credentials. */
export function createCoreSyncControlHandler(operations: Operations) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const routes = Object.values(CORE_SYNC_ROUTES);
    if (!routes.includes(path as (typeof routes)[number])) {
      return false;
    }

    if (isCrossSite(request)) {
      sendJson(response, 403, { error: "cross_site_request" });
      return true;
    }
    if (path === CORE_SYNC_ROUTES.status) {
      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET" }).end();
      } else {
        sendJson(response, 200, operations.view());
      }
      return true;
    }
    if (request.method !== "POST" && request.method !== "PUT") {
      response.writeHead(405, { allow: "POST, PUT" }).end();
      return true;
    }

    try {
      if (path === CORE_SYNC_ROUTES.connect) {
        await operations.connect(parseConnectCoreSyncRequest(await readJson(request)));
      } else if (path === CORE_SYNC_ROUTES.cancel) {
        operations.cancel();
      } else if (path === CORE_SYNC_ROUTES.disconnect) {
        operations.disconnect();
      } else if (path === CORE_SYNC_ROUTES.syncNow) {
        await operations.syncNow();
      } else if (path === CORE_SYNC_ROUTES.sources) {
        await operations.updateSources(parseUpdateCoreSyncSourcesRequest(await readJson(request)));
      } else if (path === CORE_SYNC_ROUTES.override) {
        operations.updateOverride(parseUpdateCoreInstanceOverrideRequest(await readJson(request)));
      }
      sendJson(response, 200, ACCEPTED);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync operation failed";
      const status = /already|No Sync connection|pending/i.test(message) ? 409 : 400;
      sendJson(response, status, { error: message });
    }
    return true;
  };
}
