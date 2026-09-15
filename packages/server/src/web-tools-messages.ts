import type { ClientMessage, ServerMessage, WebToolsStatus } from "@cinba/contract";
import type { WebToolsService } from "./web-tools-service.ts";

export type WebToolsMessageOptions = {
  service: WebToolsService;
  send(message: ServerMessage): void;
  broadcast(message: ServerMessage): void;
};

const UNAVAILABLE_STATUS: WebToolsStatus = {
  primary: "auto",
  effectiveOrder: ["duckduckgo"],
  providers: [
    {
      id: "exa",
      name: "Exa",
      available: false,
      hasStoredCredential: false,
      bestEffort: false,
    },
    {
      id: "brave",
      name: "Brave Search",
      available: false,
      hasStoredCredential: false,
      bestEffort: false,
    },
    {
      id: "duckduckgo",
      name: "DuckDuckGo",
      available: true,
      hasStoredCredential: false,
      bestEffort: true,
    },
  ],
};

function statusAfterFailure(service: WebToolsService): WebToolsStatus {
  try {
    return service.getStatus();
  } catch {
    return UNAVAILABLE_STATUS;
  }
}

export function handleWebToolsMessage(
  message: ClientMessage,
  options: WebToolsMessageOptions,
): boolean {
  try {
    switch (message.type) {
      case "get_web_tools_status":
        options.send({ type: "web_tools_status", status: options.service.getStatus() });
        return true;
      case "set_web_tools_api_key":
        options.broadcast({
          type: "web_tools_status",
          status: options.service.configure(message.providerId, message.apiKey),
        });
        return true;
      case "clear_web_tools_api_key":
        options.broadcast({
          type: "web_tools_status",
          status: options.service.remove(message.providerId),
        });
        return true;
      case "set_web_search_primary":
        options.broadcast({
          type: "web_tools_status",
          status: options.service.choosePrimary(message.primary),
        });
        return true;
      default:
        return false;
    }
  } catch {
    options.send({
      type: "web_tools_status",
      status: statusAfterFailure(options.service),
      error: "Could not access web tools settings",
    });
    return true;
  }
}
