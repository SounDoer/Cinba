// 服务器与客户端之间的线上协议。
//
// 与 Pi 的 JSONL 协议是两回事：那个走 transport.ts / client.ts，携带 Pi 的原始事件；
// 这个携带已经折叠好的界面动作，层级更高。两边共用这一份定义，免得各写一遍慢慢对不上。

import type { ViewAction } from "./events.ts";
import type { Snapshot } from "./session.ts";

/** 客户端 → 服务器。 */
export type ClientMessage =
  | { type: "prompt"; text: string }
  | { type: "abort" }
  | { type: "respond_confirm"; requestId: string; confirmed: boolean }
  | { type: "set_project"; cwd: string }
  | { type: "list_dir"; path: string };

/** 服务器 → 客户端。 */
export type ServerMessage =
  | { type: "snapshot"; snapshot: Snapshot; cwd: string }
  | { type: "actions"; actions: ViewAction[] }
  | { type: "reset"; cwd: string }
  /** parent 为上一级路径；已在根目录时为 null。dirs 只含子目录名，不含文件。 */
  | { type: "dir_listing"; path: string; parent: string | null; dirs: string[] };

/**
 * 校验客户端来的消息，不认识就返回 undefined 让调用方丢掉。
 *
 * 网络上来的东西一律不可信，所以逐个字段查类型——哪怕现在只监听回环地址。
 * 等 3b 真的对外开口时，这道检查已经在了。
 */
export function parseClientMessage(raw: unknown): ClientMessage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const message = raw as Record<string, unknown>;

  switch (message.type) {
    case "prompt":
      if (typeof message.text !== "string" || message.text.trim() === "") return undefined;
      return { type: "prompt", text: message.text };

    case "abort":
      return { type: "abort" };

    case "respond_confirm":
      if (typeof message.requestId !== "string" || typeof message.confirmed !== "boolean") {
        return undefined;
      }
      return {
        type: "respond_confirm",
        requestId: message.requestId,
        confirmed: message.confirmed,
      };

    case "set_project":
      if (typeof message.cwd !== "string" || message.cwd === "") return undefined;
      return { type: "set_project", cwd: message.cwd };

    case "list_dir":
      if (typeof message.path !== "string" || message.path === "") return undefined;
      return { type: "list_dir", path: message.path };

    default:
      return undefined;
  }
}
