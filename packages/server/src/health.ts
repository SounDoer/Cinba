import type { IncomingMessage, ServerResponse } from "node:http";

export type HealthSnapshot = {
  status: "ok";
  revision: string;
  safeToRestart: boolean;
};

export type HealthHandler = (request: IncomingMessage, response: ServerResponse) => boolean;

/** Only expose a Git commit, never an arbitrary environment value. */
export function normalizeRevision(value: string | undefined): string {
  return value && /^[0-9a-f]{7,40}$/i.test(value) ? value.toLowerCase() : "unknown";
}

export function isSafeToRestart(
  sessions: Iterable<{ busy: boolean; awaitingConfirmation: boolean }>,
): boolean {
  for (const session of sessions) {
    if (session.busy || session.awaitingConfirmation) {
      return false;
    }
  }
  return true;
}

/**
 * Make the small HTTP boundary used by deploy checks. Returning false means
 * the request is not for this endpoint and should continue to the UI handler.
 */
export function createHealthHandler(options: {
  revision: string;
  safeToRestart: () => boolean;
}): HealthHandler {
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/healthz") {
      return false;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" }).end();
      return true;
    }

    const snapshot: HealthSnapshot = {
      status: "ok",
      revision: options.revision,
      safeToRestart: options.safeToRestart(),
    };
    response
      .writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      })
      .end(JSON.stringify(snapshot));
    return true;
  };
}
