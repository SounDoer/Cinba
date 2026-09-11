// The client side of the connection.
//
// It sits beside PiClient rather than on top of it: PiClient speaks Pi's
// JSONL protocol, while this speaks the protocol between this project's server
// and its clients.

import {
  type ClientMessage,
  type ModelRef,
  type ProviderStatus,
  type SessionSummary,
  type Snapshot,
  type ViewAction,
  parseServerMessage,
} from "@cinba/contract";

/**
 * The lifecycle and text-message capabilities CoreClient needs from a connection.
 *
 * The native WebSocket fits this shape exactly, and browsers, the Electron
 * renderer and Node 24 all ship it, so this module needs no WebSocket library.
 * Tests and unusual platforms can provide a factory that returns a fake or adapter.
 */
export type Socket = {
  send(data: string): void;
  close(): void;
  /**
   * Browser and Node WebSockets give this event different nominal types even
   * though both expose data. Keep the platform event opaque at this boundary;
   * CoreClient immediately treats its data as unknown and validates JSON.
   */
  onmessage: ((event: any) => void) | null;
  onopen: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
};

export type SocketFactory = (url: string) => Socket;

export type CoreConnectionState = "connecting" | "connected" | "disconnected";

export type CoreClientOptions = {
  socketFactory?: SocketFactory;
};

/** Everything a snapshot says about the session it describes. An object rather than four positional arguments, which this had grown to. */
export type SnapshotState = {
  snapshot: Snapshot;
  cwd: string;
  sessionId: string;
  model: ModelRef | undefined;
};

export type CoreClientHandlers = {
  onConnectionChanged?: (state: CoreConnectionState) => void;
  onError?: (error: unknown) => void;
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

type WebSocketConstructor = new (url: string) => Socket;

function createDefaultSocket(url: string): Socket {
  const constructor = (globalThis as unknown as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (!constructor) {
    throw new Error("This platform does not provide WebSocket");
  }
  return new constructor(url);
}

/** The client-side connection to one running Cinba Core. */
export class CoreClient {
  #socket: Socket;
  #handlers: CoreClientHandlers;
  #connectionState: CoreConnectionState = "connecting";

  constructor(url: string, handlers: CoreClientHandlers, options: CoreClientOptions = {}) {
    this.#handlers = handlers;
    this.#socket = (options.socketFactory ?? createDefaultSocket)(url);
    this.#socket.onopen = () => this.#transition("connected");
    this.#socket.onmessage = (event) => this.#receive(event.data);
    this.#socket.onerror = (event) => this.#handlers.onError?.(event);
    this.#socket.onclose = () => {
      this.#transition("disconnected");
      this.#detach();
    };
    this.#handlers.onConnectionChanged?.("connecting");
  }

  get connectionState(): CoreConnectionState {
    return this.#connectionState;
  }

  prompt(text: string): boolean {
    return this.#send({ type: "prompt", text });
  }

  editMessage(entryId: string, text: string): boolean {
    return this.#send({ type: "edit_message", entryId, text });
  }

  abort(): boolean {
    return this.#send({ type: "abort" });
  }

  respondConfirm(requestId: string, confirmed: boolean): boolean {
    return this.#send({ type: "respond_confirm", requestId, confirmed });
  }

  listDir(path: string): boolean {
    return this.#send({ type: "list_dir", path });
  }

  listModels(): boolean {
    return this.#send({ type: "list_models" });
  }

  setModel(provider: string, modelId: string): boolean {
    return this.#send({ type: "set_model", provider, modelId });
  }

  listSessions(cwd?: string): boolean {
    return this.#send(
      cwd === undefined ? { type: "list_sessions" } : { type: "list_sessions", cwd },
    );
  }

  openSession(sessionId: string): boolean {
    return this.#send({ type: "open_session", sessionId });
  }

  createSession(cwd: string): boolean {
    return this.#send({ type: "create_session", cwd });
  }

  deleteSession(sessionId: string): boolean {
    return this.#send({ type: "delete_session", sessionId });
  }

  renameSession(name: string): boolean {
    return this.#send({ type: "rename_session", name });
  }

  listProviders(): boolean {
    return this.#send({ type: "list_providers" });
  }

  /** Sends a secret. The reply never contains one; nothing here logs it. */
  setApiKey(providerId: string, apiKey: string): boolean {
    return this.#send({ type: "set_api_key", providerId, apiKey });
  }

  clearCredential(providerId: string): boolean {
    return this.#send({ type: "clear_credential", providerId });
  }

  close(): void {
    if (this.#connectionState === "disconnected") {
      return;
    }
    this.#transition("disconnected");
    this.#detach();
    this.#socket.close();
  }

  #send(message: ClientMessage): boolean {
    if (this.#connectionState !== "connected") {
      return false;
    }
    try {
      this.#socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      this.#handlers.onError?.(error);
      return false;
    }
  }

  #receive(data: unknown): void {
    if (this.#connectionState !== "connected") {
      return;
    }
    if (typeof data !== "string") {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // Not JSON, ignore it
    }
    const message = parseServerMessage(parsed);
    if (!message) {
      return;
    }

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

  #transition(state: CoreConnectionState): void {
    if (this.#connectionState === state) {
      return;
    }
    this.#connectionState = state;
    this.#handlers.onConnectionChanged?.(state);
  }

  #detach(): void {
    this.#socket.onopen = null;
    this.#socket.onmessage = null;
    this.#socket.onerror = null;
    this.#socket.onclose = null;
  }
}
