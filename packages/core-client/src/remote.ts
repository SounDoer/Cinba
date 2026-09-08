// The client side of the connection.
//
// It sits beside CoreClient rather than on top of it: CoreClient speaks Pi's
// JSONL protocol, while this speaks the protocol between this project's server
// and its clients.

import type { ViewAction } from "./events.ts";
import type { Snapshot } from "./session.ts";
import type { ClientMessage, ModelRef, ServerMessage } from "./protocol.ts";

/**
 * A connection that can send and receive text messages.
 *
 * The native WebSocket fits this shape exactly, and browsers, the Electron
 * renderer and Node 24 all ship it, so this module pulls in no dependencies.
 * Tests can pass a fake.
 */
export type Socket = {
  send(data: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
};

export type RemoteHandlers = {
  onSnapshot?: (snapshot: Snapshot, cwd: string, model: ModelRef | undefined) => void;
  onActions?: (actions: ViewAction[]) => void;
  onReset?: (cwd: string) => void;
  onDirListing?: (listing: { path: string; parent: string | null; dirs: string[] }) => void;
  onModelListing?: (models: ModelRef[]) => void;
  onModelChanged?: (model: ModelRef) => void;
};

export class RemoteSession {
  #socket: Socket;
  #handlers: RemoteHandlers;

  constructor(socket: Socket, handlers: RemoteHandlers) {
    this.#socket = socket;
    this.#handlers = handlers;
    socket.onmessage = (event) => this.#receive(event.data);
  }

  prompt(text: string): void {
    this.#send({ type: "prompt", text });
  }

  abort(): void {
    this.#send({ type: "abort" });
  }

  respondConfirm(requestId: string, confirmed: boolean): void {
    this.#send({ type: "respond_confirm", requestId, confirmed });
  }

  setProject(cwd: string): void {
    this.#send({ type: "set_project", cwd });
  }

  listDir(path: string): void {
    this.#send({ type: "list_dir", path });
  }

  listModels(): void {
    this.#send({ type: "list_models" });
  }

  setModel(provider: string, modelId: string): void {
    this.#send({ type: "set_model", provider, modelId });
  }

  #send(message: ClientMessage): void {
    this.#socket.send(JSON.stringify(message));
  }

  #receive(data: unknown): void {
    if (typeof data !== "string") return;

    let message: ServerMessage;
    try {
      message = JSON.parse(data) as ServerMessage;
    } catch {
      return; // Not JSON, ignore it
    }

    switch (message.type) {
      case "snapshot":
        this.#handlers.onSnapshot?.(message.snapshot, message.cwd, message.model);
        return;
      case "actions":
        this.#handlers.onActions?.(message.actions);
        return;
      case "reset":
        this.#handlers.onReset?.(message.cwd);
        return;
      case "model_listing":
        this.#handlers.onModelListing?.(message.models);
        return;
      case "model_changed":
        this.#handlers.onModelChanged?.(message.model);
        return;
      case "dir_listing":
        this.#handlers.onDirListing?.({
          path: message.path,
          parent: message.parent,
          dirs: message.dirs,
        });
        return;
      default:
        return;
    }
  }
}
