import type { IncomingMessage, ServerResponse } from "node:http";
import { type DeploymentStatus, readDeploymentStatus } from "@cinba/deploy";

type ReadStatus = (path: string) => Promise<DeploymentStatus | undefined>;

export type DeploymentStatusHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean>;

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response
    .writeHead(statusCode, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    })
    .end(JSON.stringify(body));
}

/** Expose only the bounded deployment status schema, never its logs or filesystem context. */
export function createDeploymentStatusHandler(options: {
  statusPath: string;
  readStatus?: ReadStatus;
}): DeploymentStatusHandler {
  const readStatus = options.readStatus ?? readDeploymentStatus;

  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/deployment-status") {
      return false;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" }).end();
      return true;
    }

    try {
      const status = await readStatus(options.statusPath);
      if (!status) {
        sendJson(response, 404, { status: "unavailable", reason: "not_configured" });
        return true;
      }
      sendJson(response, 200, status);
    } catch {
      sendJson(response, 503, { status: "unavailable", reason: "invalid" });
    }
    return true;
  };
}
