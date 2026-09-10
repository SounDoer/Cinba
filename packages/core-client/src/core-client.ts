// The client side of the connection.
//
// It sits beside PiClient rather than on top of it: PiClient speaks Pi's
// JSONL protocol, while this speaks the protocol between this project's server
// and its clients.

import type {
  ClientMessage,
  ModelRef,
  ProviderStatus,
  SessionSummary,
  Snapshot,
  ViewAction,
} from "@cinba/contract";
import { parseServerMessage } from "@cinba/contract";

/**
 * A connection that can send and receive text messages.
 *
 * The native WebSocket fits this shape exactly, and browsers, the Electron
 * renderer and Node 24 all ship it, so this module pulls in no dependencies.
 * Tests can pass a fake.
 */
export type Socket = {
  send(data: string): void;
  /**
   * Browser and Node WebSockets give this event different nominal types even
   * though both expose data. Keep the platform event opaque at this boundary;
   * CoreClient immediately treats its data as unknown and validates JSON.
   */
  onmessage: ((event: any) => void) | null;
};

/** Everything a snapshot says about the session it describes. An object rather than four positional arguments, which this had grown to. */
export type SnapshotState = {
  snapshot: Snapshot;
  cwd: string;
  sessionId: string;
  model: ModelRef | undefined;
};

export type CoreClientHandlers = {
  onSnapshot?: (state: SnapshotState) => void;
  onActions?: (actions: ViewAction[]) => void;
  onDirListing?: (listing: { path: string; parent: string | null; dirs: string[] }) => void;
  onModelListing?: (models: ModelRef[]) => void;
  onModelChanged?: (model: ModelRef) => void;
  onSessionListing?: (sessions: SessionSummary[]) => void;
  onSessionOpened?: (sessionId: string) => void;
  onProviderListing?: (providers: ProviderStatus[]) => void;
  onCoreIdentity?: (name: string) => void;
};

/** The client-side connection to one running Cinba Core. */
export class CoreClient {
  #socket: Socket;
  #handlers: CoreClientHandlers;

  constructor(socket: Socket, handlers: CoreClientHandlers) {
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

  listDir(path: string): void {
    this.#send({ type: "list_dir", path });
  }

  listModels(): void {
    this.#send({ type: "list_models" });
  }

  setModel(provider: string, modelId: string): void {
    this.#send({ type: "set_model", provider, modelId });
  }

  listSessions(cwd?: string): void {
    this.#send(cwd === undefined ? { type: "list_sessions" } : { type: "list_sessions", cwd });
  }

  openSession(sessionId: string): void {
    this.#send({ type: "open_session", sessionId });
  }

  createSession(cwd: string): void {
    this.#send({ type: "create_session", cwd });
  }

  deleteSession(sessionId: string): void {
    this.#send({ type: "delete_session", sessionId });
  }

  renameSession(name: string): void {
    this.#send({ type: "rename_session", name });
  }

  listProviders(): void {
    this.#send({ type: "list_providers" });
  }

  /** Sends a secret. The reply never contains one; nothing here logs it. */
  setApiKey(providerId: string, apiKey: string): void {
    this.#send({ type: "set_api_key", providerId, apiKey });
  }

  clearCredential(providerId: string): void {
    this.#send({ type: "clear_credential", providerId });
  }

  #send(message: ClientMessage): void {
    this.#socket.send(JSON.stringify(message));
  }

  #receive(data: unknown): void {
    if (typeof data !== "string") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // Not JSON, ignore it
    }
    const message = parseServerMessage(parsed);
    if (!message) return;

    switch (message.type) {
      case "snapshot":
        this.#handlers.onSnapshot?.({
          snapshot: message.snapshot,
          cwd: message.cwd,
          sessionId: message.sessionId,
          model: message.model,
        });
        return;
      case "actions":
        this.#handlers.onActions?.(message.actions);
        return;
      case "core_identity":
        this.#handlers.onCoreIdentity?.(message.name);
        return;
      case "provider_listing":
        this.#handlers.onProviderListing?.(message.providers);
        return;
      case "session_listing":
        this.#handlers.onSessionListing?.(message.sessions);
        return;
      case "session_opened":
        this.#handlers.onSessionOpened?.(message.sessionId);
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
