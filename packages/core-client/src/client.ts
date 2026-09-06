import type { Transport } from "./transport.ts";

/** 需要客户端回话的 UI 方法。其余（notify、setStatus 等）是广播式的。 */
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

/** 三种回应形态之一，见 Pi 的 RpcExtensionUIResponse。 */
export type UiReply =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

export type UiRequestHandler = (request: UiRequest) => Promise<UiReply>;

/**
 * 协议层客户端。
 *
 * 与 Pi 内置的 RpcClient 的区别：那个类的 send() 和 process 都是 private，
 * 无法把 extension_ui_response 写回 stdin，权限门因此无法工作。
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

  /** 订阅事件流。返回取消订阅的函数。 */
  onEvent(listener: (event: CoreEvent) => void): () => void {
    this.#eventListeners.push(listener);
    return () => {
      const index = this.#eventListeners.indexOf(listener);
      if (index >= 0) this.#eventListeners.splice(index, 1);
    };
  }

  /** 注册 UI 请求处理器。前端在这里弹窗、拿用户的选择。 */
  onUiRequest(handler: UiRequestHandler): void {
    this.#uiHandler = handler;
  }

  prompt(message: string): Promise<CoreResponse> {
    return this.#send({ type: "prompt", message });
  }

  abort(): Promise<CoreResponse> {
    return this.#send({ type: "abort" });
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
      return; // 非 JSON 的行直接忽略
    }

    // 命令回执：按 id 找到等待中的 Promise
    if (data.type === "response" && typeof data.id === "string") {
      const resolve = this.#pending.get(data.id);
      if (resolve) {
        this.#pending.delete(data.id);
        resolve(data as CoreResponse);
        return;
      }
    }

    // extension UI 请求
    if (data.type === "extension_ui_request") {
      void this.#handleUiRequest(data as UiRequest);
      return;
    }

    // 其余都是事件
    for (const listener of this.#eventListeners) listener(data);
  }

  async #handleUiRequest(request: UiRequest): Promise<void> {
    // 广播式的方法照样交给处理器（前端可以显示通知），但不回话。
    const needsReply = DIALOG_METHODS.has(request.method);

    if (!this.#uiHandler) {
      // 没人处理阻塞式请求的话，核心会一直卡着，所以直接回「取消」。
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
