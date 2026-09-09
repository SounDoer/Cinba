// The HTTP side of the web UI: map request paths to files in one build directory.
// It knows nothing about WebSockets, sessions, Pi, or server configuration.

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export type StaticFileHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>;

/** Make a handler rooted at one web build directory. */
export function createStaticFileHandler(root: string): StaticFileHandler {
  const normalizedRoot = normalize(root);

  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const requested = url.pathname === "/" ? "/index.html" : url.pathname;

    // Guard against path traversal: join first, then check the result is still
    // under the configured root. The check belongs here so every HTTP server
    // using this handler gets the same boundary protection.
    const filePath = normalize(join(normalizedRoot, requested));
    if (!filePath.startsWith(normalizedRoot + sep) && filePath !== normalizedRoot) {
      response.writeHead(403).end("forbidden");
      return;
    }

    try {
      const body = await readFile(filePath);
      response.writeHead(200, {
        "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
      });
      response.end(body);
    } catch {
      response
        .writeHead(404)
        .end("The UI is not built yet. Run: npm run build --workspace @cinba/web");
    }
  };
}
