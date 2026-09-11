// Owns the network and timer resources of one running Cinba service.
// Creating it is inert; start() acquires resources and stop() releases them.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

export type ServerAddress = {
  host: string;
  port: number;
};

export type ServerRuntime = {
  start(): Promise<ServerAddress>;
  stop(): Promise<void>;
};

export type ServerRuntimeOptions = {
  host: string;
  port: number;
  webSocketPath?: string;
  serveHttp(request: IncomingMessage, response: ServerResponse): void | Promise<void>;
  onConnection(socket: WebSocket, request: IncomingMessage): void;
  maintain?: () => void;
  maintenanceIntervalMs?: number;
};

/** Create a one-shot runtime without opening a port or starting a timer. */
export function createServerRuntime(options: ServerRuntimeOptions): ServerRuntime {
  const httpServer = createServer((request, response) => {
    void options.serveHttp(request, response);
  });
  const webSocketServer = new WebSocketServer({
    server: httpServer,
    path: options.webSocketPath ?? "/ws",
  });
  webSocketServer.on("connection", options.onConnection);

  let state: "created" | "running" | "stopped" = "created";
  let address: ServerAddress | undefined;
  let maintenanceTimer: NodeJS.Timeout | undefined;

  async function start(): Promise<ServerAddress> {
    if (state === "running") return address!;
    if (state === "stopped") throw new Error("A stopped server runtime cannot be restarted");

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      httpServer.once("error", onError);
      httpServer.listen(options.port, options.host, () => {
        httpServer.off("error", onError);
        resolve();
      });
    });

    const bound = httpServer.address();
    if (!bound || typeof bound === "string") {
      throw new Error("The HTTP server did not report a TCP address");
    }

    address = { host: options.host, port: bound.port };
    state = "running";

    if (options.maintain) {
      maintenanceTimer = setInterval(options.maintain, options.maintenanceIntervalMs ?? 60_000);
      maintenanceTimer.unref();
    }

    return address;
  }

  async function stop(): Promise<void> {
    if (state !== "running") {
      state = "stopped";
      return;
    }
    state = "stopped";

    if (maintenanceTimer) {
      clearInterval(maintenanceTimer);
      maintenanceTimer = undefined;
    }

    // A server cannot finish closing while clients remain connected. Terminate
    // them here because the runtime owns the listener they are connected to.
    for (const client of webSocketServer.clients) client.terminate();

    await new Promise<void>((resolve, reject) => {
      webSocketServer.close((error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }

  return { start, stop };
}
