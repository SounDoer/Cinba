import { existsSync } from "node:fs";
import { type Server, createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventEmitter } from "node:events";
import { createSyncApiHandler } from "./routes/sync-api-routes.ts";
import { createSyncWebStaticHandler } from "./routes/sync-web-static.ts";
import { AdministratorAuthService } from "./services/administrator-auth.ts";
import { syncMaintenancePath } from "./services/backup-service.ts";
import { createSyncStore } from "./store/sync-store.ts";

export type SyncServerOptions = {
  stateDirectory: string;
  host: string;
  port: number;
  publicOrigin: string;
  webRoot?: string;
};

export function defaultSyncStateDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.CINBA_SYNC_STATE_DIR?.trim();
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error("CINBA_SYNC_STATE_DIR must be an absolute path");
    }
    return configured;
  }
  return join(homedir(), ".cinba-sync");
}

export function assertLoopbackSyncHost(host: string): void {
  if (!new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(host.toLowerCase())) {
    throw new Error(
      "Sync Server must bind to loopback and be exposed through an HTTPS reverse proxy",
    );
  }
}

export function createSyncServer(options: SyncServerOptions): Server {
  assertLoopbackSyncHost(options.host);
  const store = createSyncStore(options.stateDirectory, {
    readOnly: () => existsSync(syncMaintenancePath(options.stateDirectory)),
  });
  if (store.problem()) {
    throw store.problem();
  }
  const administrator = new AdministratorAuthService({
    store,
    origin: options.publicOrigin,
    cookieMode: ["127.0.0.1", "localhost", "[::1]"].includes(new URL(options.publicOrigin).hostname)
      ? "loopback-development"
      : "secure",
  });
  const api = createSyncApiHandler({ store, administrator });
  const webRoot =
    options.webRoot ??
    join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "sync-web", "dist");
  const staticFiles = createSyncWebStaticHandler(webRoot);
  return createHttpServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/health" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ version: 1, status: "ok", serverId: store.serverId() }));
      return;
    }
    const publicUrl = new URL(options.publicOrigin);
    if (
      publicUrl.protocol === "https:" &&
      (request.headers["x-forwarded-proto"] !== "https" ||
        request.headers["x-forwarded-host"] !== publicUrl.host)
    ) {
      response
        .writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" })
        .end(JSON.stringify({ version: 1, error: "invalid_reverse_proxy" }));
      return;
    }
    if (path === "/api" || path.startsWith("/api/")) {
      await api(request, response);
      return;
    }
    if (await staticFiles(request, response)) {
      return;
    }
    response.writeHead(404, { "Cache-Control": "no-store" }).end();
  });
}

export async function runSyncServer(
  options: SyncServerOptions,
  signals: Pick<EventEmitter, "once"> = process,
): Promise<void> {
  assertLoopbackSyncHost(options.host);
  const server = createSyncServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  const status = inspectForStartup(options.stateDirectory);
  console.log(`[sync] Cinba Sync is listening at ${options.publicOrigin}`);
  if (status.setupCode) {
    console.log(`[sync] Setup Code: ${status.setupCode}`);
  }
  await new Promise<void>((resolve) => {
    let closing = false;
    const close = () => {
      if (closing) {
        return;
      }
      closing = true;
      server.close(() => resolve());
    };
    signals.once("SIGINT", close);
    signals.once("SIGTERM", close);
  });
}

function inspectForStartup(directory: string): { setupCode?: string } {
  const store = createSyncStore(directory);
  return store.authenticationState() === "setup-required"
    ? { setupCode: store.localSetupCode() }
    : {};
}
