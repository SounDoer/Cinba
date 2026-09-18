import { existsSync } from "node:fs";
import { type Server, createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventEmitter } from "node:events";
import { createLocalSyncControlHandler } from "./local-sync-control.ts";
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

export function createSyncServer(
  options: SyncServerOptions,
  localControl: {
    token?: string;
    requestStop?: () => void;
  } = {},
): Server {
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
    cookieMode:
      new URL(options.publicOrigin).protocol === "https:" ? "secure" : "loopback-development",
  });
  const api = createSyncApiHandler({ store, administrator });
  const webRoot =
    options.webRoot ??
    join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "sync-web", "dist");
  const staticFiles = createSyncWebStaticHandler(webRoot);
  let activeRequestCount = 0;
  let draining = false;
  const control = createLocalSyncControlHandler({
    token: localControl.token,
    snapshot: () => ({ activeRequestCount, draining }),
    beginStop: () => {
      if (activeRequestCount > 0 || draining) {
        return false;
      }
      draining = true;
      return true;
    },
    requestStop: localControl.requestStop ?? (() => undefined),
  });
  return createHttpServer(async (request, response) => {
    if (control(request, response)) {
      return;
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/health" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ version: 1, status: "ok", serverId: store.serverId() }));
      return;
    }
    if (draining) {
      response
        .writeHead(503, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        })
        .end(JSON.stringify({ version: 1, error: "sync_draining" }));
      return;
    }
    activeRequestCount += 1;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        activeRequestCount -= 1;
      }
    };
    response.once("finish", release);
    response.once("close", release);
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

export function closeSyncServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function runSyncServer(
  options: SyncServerOptions,
  signals: Pick<EventEmitter, "once"> = process,
): Promise<void> {
  assertLoopbackSyncHost(options.host);
  let requestStop: () => void = () => undefined;
  const stopping = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  const server = createSyncServer(options, {
    ...(process.env.CINBA_LOCAL_SYNC_CONTROL_TOKEN
      ? { token: process.env.CINBA_LOCAL_SYNC_CONTROL_TOKEN }
      : {}),
    requestStop,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  const status = inspectForStartup(options.stateDirectory);
  console.log(`[sync] Cinba Sync is listening at ${options.publicOrigin}`);
  if (status.setupCode) {
    console.log(`[sync] Setup Code: ${status.setupCode}`);
  }
  signals.once("SIGINT", requestStop);
  signals.once("SIGTERM", requestStop);
  await stopping;
  await closeSyncServer(server);
}

function inspectForStartup(directory: string): { setupCode?: string } {
  const store = createSyncStore(directory);
  return store.authenticationState() === "setup-required"
    ? { setupCode: store.localSetupCode() }
    : {};
}
