import type { PromptStreamingBehavior } from "@cinba/contract";
import type { Transport } from "./transport.ts";

/** UI methods that expect an answer. The rest (notify, setStatus, ...) are broadcasts. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export type CoreEvent = { type: string; [key: string]: unknown };

export type CoreResponse = {
  type: "response";
  command: string;
  id?: string;
  success: boolean;
  [key: string]: unknown;
};

export type UiRequest = {
  type: "extension_ui_request";
  id: string;
  method: string;
  [key: string]: unknown;
};

/** One of three reply shapes; see Pi's RpcExtensionUIResponse. */
export type UiReply = { value: string } | { confirmed: boolean } | { cancelled: true };

export type UiRequestHandler = (request: UiRequest) => Promise<UiReply>;

/**
 * The protocol-level client.
 *
 * How it differs from Pi's built-in RpcClient: there, both send() and process
 * are private, so extension_ui_response cannot be written back to stdin, which
 * leaves the permission gate unable to work.
 */
export class PiClient {
  #transport: Transport;
  #pending = new Map<
    string,
    {
      resolve: (response: CoreResponse) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  #eventListeners: Array<(event: CoreEvent) => void> = [];
  #closeListeners: Array<(error?: Error) => void> = [];
  #uiHandler: UiRequestHandler | undefined;
  #nextId = 0;
  #closedError: Error | undefined;
  #closed = false;
  #transportCloseError: Error | undefined;
  #requestTimeoutMs: number;

  constructor(transport: Transport, requestTimeoutMs = 30_000) {
    this.#transport = transport;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#transport.onLine((line) => this.#handleLine(line));
    this.#transport.onClose((error) => {
      this.#closed = true;
      this.#transportCloseError = error;
      this.#failPending(error ?? new Error("Pi transport closed"));
      for (const listener of this.#closeListeners) {
        listener(error);
      }
      this.#closeListeners = [];
    });
  }

  /** Subscribe to the event stream. Returns a function that unsubscribes. */
  onEvent(listener: (event: CoreEvent) => void): () => void {
    this.#eventListeners.push(listener);
    return () => {
      const index = this.#eventListeners.indexOf(listener);
      if (index >= 0) {
        this.#eventListeners.splice(index, 1);
      }
    };
  }

  /** Subscribe to transport loss. Late subscribers are notified immediately. */
  onClose(listener: (error?: Error) => void): () => void {
    if (this.#closed) {
      listener(this.#transportCloseError);
      return () => {};
    }
    this.#closeListeners.push(listener);
    return () => {
      const index = this.#closeListeners.indexOf(listener);
      if (index >= 0) {
        this.#closeListeners.splice(index, 1);
      }
    };
  }

  /** Register the UI request handler. This is where a frontend prompts and collects the answer. */
  onUiRequest(handler: UiRequestHandler): void {
    this.#uiHandler = handler;
  }

  prompt(message: string, streamingBehavior?: PromptStreamingBehavior): Promise<CoreResponse> {
    return this.#send(
      streamingBehavior === undefined
        ? { type: "prompt", message }
        : { type: "prompt", message, streamingBehavior },
    );
  }

  clearQueue(): Promise<CoreResponse> {
    return this.#send({ type: "clear_queue" });
  }

  abort(): Promise<CoreResponse> {
    return this.#send({ type: "abort" });
  }

  /** Session state, including which model is currently in use. */
  getState(): Promise<CoreResponse> {
    return this.#send({ type: "get_state" });
  }

  /**
   * The models this machine can actually use.
   *
   * Pi knows of dozens of providers but only returns the ones with credentials
   * configured, which is exactly the list worth offering. It reads local files
   * only, so this is cheap and works offline.
   */
  getAvailableModels(): Promise<CoreResponse> {
    return this.#send({ type: "get_available_models" });
  }

  /**
   * Switch models on the running process.
   *
   * No restart is involved and the conversation carries on, which is the point:
   * a weak answer can be handed to a stronger model with its context intact.
   */
  setModel(provider: string, modelId: string): Promise<CoreResponse> {
    return this.#send({ type: "set_model", provider, modelId });
  }

  /**
   * The conversation as Pi has stored it.
   *
   * @param since Return only what follows this entry id. This is how the server
   *              reconciles cheaply at the end of each turn instead of pulling
   *              a long conversation back every time.
   */
  getEntries(since?: string): Promise<CoreResponse> {
    return this.#send(
      since === undefined ? { type: "get_entries" } : { type: "get_entries", since },
    );
  }

  /** Start a fresh conversation in this process, leaving the previous one on disk. */
  newSession(): Promise<CoreResponse> {
    return this.#send({ type: "new_session" });
  }

  /** Point this process at an existing session file. */
  switchSession(sessionPath: string): Promise<CoreResponse> {
    return this.#send({ type: "switch_session", sessionPath });
  }

  setSessionName(name: string): Promise<CoreResponse> {
    return this.#send({ type: "set_session_name", name });
  }

  async close(): Promise<void> {
    this.#failPending(new Error("Pi transport closed"));
    await this.#transport.close();
  }

  #send(command: Record<string, unknown>): Promise<CoreResponse> {
    if (this.#closedError) {
      return Promise.reject(this.#closedError);
    }
    this.#nextId += 1;
    const id = String(this.#nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Pi command ${String(command.type)} timed out`));
      }, this.#requestTimeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#transport.send(JSON.stringify({ ...command, id }));
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #handleLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return; // Not a JSON line, ignore it
    }
    if (typeof raw !== "object" || raw === null) {
      return;
    }
    const data = raw as Record<string, unknown>;
    if (typeof data.type !== "string") {
      return;
    }

    // Command reply: find the waiting promise by id
    if (data.type === "response") {
      if (
        typeof data.id !== "string" ||
        typeof data.command !== "string" ||
        typeof data.success !== "boolean"
      ) {
        return;
      }
      const pending = this.#pending.get(data.id);
      if (pending) {
        this.#pending.delete(data.id);
        clearTimeout(pending.timer);
        pending.resolve(data as CoreResponse);
        return;
      }
      return;
    }

    // An extension UI request
    if (data.type === "extension_ui_request") {
      if (typeof data.id !== "string" || typeof data.method !== "string") {
        return;
      }
      void this.#handleUiRequest(data as UiRequest);
      return;
    }

    // Everything else is an event
    for (const listener of this.#eventListeners) {
      listener(data as CoreEvent);
    }
  }

  async #handleUiRequest(request: UiRequest): Promise<void> {
    // Broadcast methods still reach the handler so a frontend can show them, but get no reply.
    const needsReply = DIALOG_METHODS.has(request.method);

    if (!this.#uiHandler) {
      // With nobody to handle a blocking request the core would stall, so answer "cancelled".
      if (needsReply) {
        try {
          this.#transport.send(
            JSON.stringify({
              type: "extension_ui_response",
              id: request.id,
              cancelled: true,
            }),
          );
        } catch {
          // The transport is already gone; there is nobody left to answer.
        }
      }
      return;
    }

    let reply: UiReply;
    try {
      reply = await this.#uiHandler(request);
    } catch {
      reply = { cancelled: true };
    }
    if (!needsReply) {
      return;
    }

    try {
      this.#transport.send(
        JSON.stringify({
          type: "extension_ui_response",
          id: request.id,
          ...reply,
        }),
      );
    } catch {
      // The transport is already gone; there is nobody left to answer.
    }
  }

  #failPending(error: Error): void {
    if (this.#closedError) {
      return;
    }
    this.#closedError = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
