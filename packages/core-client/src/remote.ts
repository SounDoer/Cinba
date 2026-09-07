// 客户端这一侧的连接。
//
// 与 CoreClient 并列，不是叠加：CoreClient 说的是 Pi 的 JSONL 协议，
// 这个说的是本项目服务器与客户端之间的协议。

import type { ViewAction } from "./events.ts";
import type { Snapshot } from "./session.ts";
import type { ClientMessage, ServerMessage } from "./protocol.ts";

/**
 * 一个能收发文本消息的连接。
 *
 * 原生 WebSocket 正好满足这个形状——浏览器、Electron 渲染层、Node 24 都有它，
 * 所以本模块不引入任何依赖。测试时喂一个假的即可。
 */
export type Socket = {
  send(data: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
};

export type RemoteHandlers = {
  onSnapshot?: (snapshot: Snapshot, cwd: string) => void;
  onActions?: (actions: ViewAction[]) => void;
  onReset?: (cwd: string) => void;
  onDirListing?: (listing: { path: string; parent: string | null; dirs: string[] }) => void;
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

  #send(message: ClientMessage): void {
    this.#socket.send(JSON.stringify(message));
  }

  #receive(data: unknown): void {
    if (typeof data !== "string") return;

    let message: ServerMessage;
    try {
      message = JSON.parse(data) as ServerMessage;
    } catch {
      return; // 非 JSON 直接忽略
    }

    switch (message.type) {
      case "snapshot":
        this.#handlers.onSnapshot?.(message.snapshot, message.cwd);
        return;
      case "actions":
        this.#handlers.onActions?.(message.actions);
        return;
      case "reset":
        this.#handlers.onReset?.(message.cwd);
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
