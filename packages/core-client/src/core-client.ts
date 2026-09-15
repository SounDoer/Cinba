// The client side of the connection.
//
// It sits beside PiClient rather than on top of it: PiClient speaks Pi's
// JSONL protocol, while this speaks the protocol between this project's server
// and its clients.

import {
  type ClientMessage,
  type ModelRef,
  type PromptStreamingBehavior,
  type ProviderStatus,
  type RecoveredDraft,
  type SessionSummary,
  type Snapshot,
  type ViewAction,
  type WebSearchCredentialProviderId,
  type WebSearchPrimary,
  type WebToolsStatus,
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

export type ReconnectScheduler = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type CoreConnectionState = "connecting" | "connected" | "disconnected";

export type CoreClientOptions = {
  socketFactory?: SocketFactory;
  autoReconnect?: boolean;
  reconnectScheduler?: ReconnectScheduler;
};

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

const defaultReconnectScheduler: ReconnectScheduler = {
  setTimeout: (callback, delayMs) =>
    (
      globalThis as unknown as { setTimeout(callback: () => void, delayMs: number): unknown }
    ).setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    (globalThis as unknown as { clearTimeout(handle: unknown): void }).clearTimeout(handle),
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
  onWebToolsStatus?: (status: WebToolsStatus, error?: string) => void;
  onCoreIdentity?: (name: string) => void;
  onDraftsRecovered?: (drafts: RecoveredDraft[]) => void;
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
  readonly #url: string;
  readonly #socketFactory: SocketFactory;
  readonly #autoReconnect: boolean;
  readonly #reconnectScheduler: ReconnectScheduler;
  #handlers: CoreClientHandlers;
  #socket: Socket | undefined;
  #reconnectTimer: unknown;
  #nextReconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  #closed = false;
  #connectionState: CoreConnectionState = "connecting";

  constructor(url: string, handlers: CoreClientHandlers, options: CoreClientOptions = {}) {
    this.#url = url;
    this.#handlers = handlers;
    this.#socketFactory = options.socketFactory ?? createDefaultSocket;
    this.#autoReconnect = options.autoReconnect ?? false;
    this.#reconnectScheduler = options.reconnectScheduler ?? defaultReconnectScheduler;
    this.#handlers.onConnectionChanged?.("connecting");
    this.#connect();
  }

  get connectionState(): CoreConnectionState {
    return this.#connectionState;
  }

  prompt(text: string): boolean {
    return this.#send({ type: "prompt", text });
  }

  steer(text: string): boolean {
    return this.#promptWhileStreaming(text, "steer");
  }

  followUp(text: string): boolean {
    return this.#promptWhileStreaming(text, "followUp");
  }

  #promptWhileStreaming(text: string, streamingBehavior: PromptStreamingBehavior): boolean {
    return this.#send({ type: "prompt", text, streamingBehavior });
  }

  clearQueue(): boolean {
    return this.#send({ type: "clear_queue" });
  }

  editMessage(entryId: string, text: string): boolean {
    return this.#send({ type: "edit_message", entryId, text });
  }

  abort(): boolean {
    return this.#send({ type: "abort" });
  }

  compact(): boolean {
    return this.#send({ type: "compact" });
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

  getWebToolsStatus(): boolean {
    return this.#send({ type: "get_web_tools_status" });
  }

  /** Sends a web search secret. Status replies expose only its source and presence. */
  setWebToolsApiKey(providerId: WebSearchCredentialProviderId, apiKey: string): boolean {
    return this.#send({ type: "set_web_tools_api_key", providerId, apiKey });
  }

  clearWebToolsApiKey(providerId: WebSearchCredentialProviderId): boolean {
    return this.#send({ type: "clear_web_tools_api_key", providerId });
  }

  setWebSearchPrimary(primary: WebSearchPrimary): boolean {
    return this.#send({ type: "set_web_search_primary", primary });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#reconnectTimer !== undefined) {
      this.#reconnectScheduler.clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket) {
      this.#detach(socket);
    }
    this.#transition("disconnected");
    socket?.close();
  }

  #send(message: ClientMessage): boolean {
    const socket = this.#socket;
    if (this.#connectionState !== "connected" || !socket) {
      return false;
    }
    try {
      socket.send(JSON.stringify(message));
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
      case "drafts_recovered":
        this.#handlers.onDraftsRecovered?.(message.drafts);
        return;
      case "provider_listing":
        this.#handlers.onProviderListing?.(message.providers);
        return;
      case "web_tools_status":
        this.#handlers.onWebToolsStatus?.(message.status, message.error);
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

  #connect(): void {
    if (this.#closed || this.#socket || this.#reconnectTimer !== undefined) {
      return;
    }
    this.#transition("connecting");

    let socket: Socket;
    try {
      socket = this.#socketFactory(this.#url);
    } catch (error) {
      this.#handlers.onError?.(error);
      this.#transition("disconnected");
      this.#scheduleReconnect();
      return;
    }

    this.#socket = socket;
    socket.onopen = () => {
      if (this.#closed || this.#socket !== socket) {
        return;
      }
      this.#nextReconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      this.#transition("connected");
    };
    socket.onmessage = (event) => {
      if (this.#socket === socket) {
        this.#receive(event.data);
      }
    };
    socket.onerror = (event) => {
      if (this.#socket === socket) {
        this.#handlers.onError?.(event);
      }
    };
    socket.onclose = () => {
      if (this.#socket !== socket) {
        return;
      }
      this.#detach(socket);
      this.#socket = undefined;
      this.#transition("disconnected");
      this.#scheduleReconnect();
    };
  }

  #scheduleReconnect(): void {
    if (!this.#autoReconnect || this.#closed || this.#reconnectTimer !== undefined) {
      return;
    }
    const delayMs = this.#nextReconnectDelayMs;
    this.#nextReconnectDelayMs = Math.min(delayMs * 2, MAX_RECONNECT_DELAY_MS);
    this.#reconnectTimer = this.#reconnectScheduler.setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, delayMs);
  }

  #detach(socket: Socket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
  }
}
