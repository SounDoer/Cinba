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
export type UiReply =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

export type UiRequestHandler = (request: UiRequest) => Promise<UiReply>;

/**
 * The protocol-level client.
 *
 * How it differs from Pi's built-in RpcClient: there, both send() and process
 * are private, so extension_ui_response cannot be written back to stdin, which
 * leaves the permission gate unable to work.
 */
export class CoreClient {
  #transport: Transport;
  #pending = new Map<string, (response: CoreResponse) => void>();
  #eventListeners: Array<(event: CoreEvent) => void> = [];
  #uiHandler: UiRequestHandler | undefined;
  #nextId = 0;

  constructor(transport: Transport) {
    this.#transport = transport;
    this.#transport.onLine((line) => this.#handleLine(line));
  }

  /** Subscribe to the event stream. Returns a function that unsubscribes. */
  onEvent(listener: (event: CoreEvent) => void): () => void {
    this.#eventListeners.push(listener);
    return () => {
      const index = this.#eventListeners.indexOf(listener);
      if (index >= 0) this.#eventListeners.splice(index, 1);
    };
  }

  /** Register the UI request handler. This is where a frontend prompts and collects the answer. */
  onUiRequest(handler: UiRequestHandler): void {
    this.#uiHandler = handler;
  }

  prompt(message: string): Promise<CoreResponse> {
    return this.#send({ type: "prompt", message });
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
    return this.#send(since === undefined ? { type: "get_entries" } : { type: "get_entries", since });
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

  close(): Promise<void> {
    return this.#transport.close();
  }

  #send(command: Record<string, unknown>): Promise<CoreResponse> {
    const id = String(++this.#nextId);
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#transport.send(JSON.stringify({ ...command, id }));
    });
  }

  #handleLine(line: string): void {
    let data: CoreEvent;
    try {
      data = JSON.parse(line) as CoreEvent;
    } catch {
      return; // Not a JSON line, ignore it
    }

    // Command reply: find the waiting promise by id
    if (data.type === "response" && typeof data.id === "string") {
      const resolve = this.#pending.get(data.id);
      if (resolve) {
        this.#pending.delete(data.id);
        resolve(data as CoreResponse);
        return;
      }
    }

    // An extension UI request
    if (data.type === "extension_ui_request") {
      void this.#handleUiRequest(data as UiRequest);
      return;
    }

    // Everything else is an event
    for (const listener of this.#eventListeners) listener(data);
  }

  async #handleUiRequest(request: UiRequest): Promise<void> {
    // Broadcast methods still reach the handler so a frontend can show them, but get no reply.
    const needsReply = DIALOG_METHODS.has(request.method);

    if (!this.#uiHandler) {
      // With nobody to handle a blocking request the core would stall, so answer "cancelled".
      if (needsReply) {
        this.#transport.send(
          JSON.stringify({
            type: "extension_ui_response",
            id: request.id,
            cancelled: true,
          }),
        );
      }
      return;
    }

    const reply = await this.#uiHandler(request);
    if (!needsReply) return;

    this.#transport.send(
      JSON.stringify({
        type: "extension_ui_response",
        id: request.id,
        ...reply,
      }),
    );
  }
}
