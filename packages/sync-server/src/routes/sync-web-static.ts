import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export function createSyncWebStaticHandler(rootDirectory: string) {
  const root = resolve(rootDirectory);
  const index = resolve(root, "index.html");

  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return false;
    }
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return false;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      response.writeHead(400, { "Cache-Control": "no-store" }).end();
      return true;
    }
    const requested = resolve(root, `.${decoded}`);
    if (!inside(root, requested)) {
      response.writeHead(404, { "Cache-Control": "no-store" }).end();
      return true;
    }
    const requestedExists = existsSync(requested) && statSync(requested).isFile();
    const hasExtension = extname(decoded) !== "";
    let path: string | undefined;
    if (requestedExists) {
      path = requested;
    } else if (!hasExtension) {
      path = index;
    }
    if (!path || !existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404, { "Cache-Control": "no-store" }).end();
      return true;
    }

    const immutable = requestedExists && decoded.startsWith("/assets/");
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (request.method === "HEAD") {
      response.end();
    } else {
      createReadStream(path).pipe(response);
    }
    return true;
  };
}
