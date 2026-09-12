import type { IncomingMessage } from "node:http";
import { isLoopback } from "./loopback.ts";

function isLocalHostname(hostname: string): boolean {
  if (hostname === "localhost") {
    return true;
  }
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return isLoopback(unwrapped);
}

/**
 * Browsers always send Origin during a WebSocket handshake. Requiring it to
 * name the requested Cinba host stops an unrelated page on the same trusted
 * device from driving the core. Non-browser clients such as the TUI send no
 * Origin and remain supported.
 */
export function isAllowedWebSocketOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) {
    return true;
  }
  const requestedHost = request.headers.host;
  if (!requestedHost) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.origin !== origin || parsed.host.toLowerCase() !== requestedHost.toLowerCase()) {
    return false;
  }
  if (parsed.protocol === "https:") {
    return true;
  }
  return parsed.protocol === "http:" && isLocalHostname(parsed.hostname);
}
