// The wire protocol between server and client.
//
// Distinct from Pi's JSONL protocol: that one goes through transport.ts and
// client.ts and carries Pi's raw events. This one carries already-folded view
// actions and sits a level higher. Both sides share this single definition so
// the two ends cannot drift apart.

import type { ViewAction } from "./events.ts";
import type { Snapshot } from "./session.ts";

/** Points at one model. Provider and id together, because ids are only unique within a provider. */
export type ModelRef = { provider: string; id: string };

/** Client to server. */
export type ClientMessage =
  | { type: "prompt"; text: string }
  | { type: "abort" }
  | { type: "respond_confirm"; requestId: string; confirmed: boolean }
  | { type: "set_project"; cwd: string }
  | { type: "list_dir"; path: string }
  | { type: "list_models" }
  | { type: "set_model"; provider: string; modelId: string };

/** Server to client. */
export type ServerMessage =
  /** model is absent only in the moment before the server has asked Pi which one it picked. */
  | { type: "snapshot"; snapshot: Snapshot; cwd: string; model?: ModelRef }
  | { type: "actions"; actions: ViewAction[] }
  | { type: "reset"; cwd: string }
  /** parent is the path one level up, or null at the root. dirs holds subdirectory names only, no files. */
  | { type: "dir_listing"; path: string; parent: string | null; dirs: string[] }
  /** Only the models with credentials configured on the core's machine; the rest are unusable anyway. */
  | { type: "model_listing"; models: ModelRef[] }
  | { type: "model_changed"; model: ModelRef };

/**
 * Validate a message from a client; return undefined for anything unrecognized
 * so the caller can drop it.
 *
 * Anything arriving over the network is untrusted, so every field gets a type
 * check — even though we currently listen on the loopback address only. By the
 * time 3b opens a real door outward, this check is already in place.
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

    case "list_models":
      return { type: "list_models" };

    case "set_model":
      if (
        typeof message.provider !== "string" ||
        message.provider === "" ||
        typeof message.modelId !== "string" ||
        message.modelId === ""
      ) {
        return undefined;
      }
      return { type: "set_model", provider: message.provider, modelId: message.modelId };

    default:
      return undefined;
  }
}
