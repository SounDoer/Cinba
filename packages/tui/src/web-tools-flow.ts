import type { Component } from "@earendil-works/pi-tui";
import type {
  WebSearchCredentialProviderId,
  WebSearchPrimary,
  WebSearchProviderId,
  WebToolsStatus,
} from "@cinba/contract";
import { ChoicePicker, SecretInput } from "./settings-components.ts";
import { GREEN, RESET } from "./theme.ts";

export type WebToolsClient = {
  getWebToolsStatus(): boolean;
  setWebToolsApiKey(provider: WebSearchCredentialProviderId, apiKey: string): boolean;
  clearWebToolsApiKey(provider: WebSearchCredentialProviderId): boolean;
  setWebSearchPrimary(primary: WebSearchPrimary): boolean;
};

export type WebToolsFlowHost = {
  append(line: string): void;
  showInteraction(component: Component): void;
  showPrompt(): void;
  requestRender(): void;
  showNotice(text: string): void;
};

const PROVIDER_NAMES: Record<WebSearchProviderId, string> = {
  exa: "Exa",
  brave: "Brave Search",
  duckduckgo: "DuckDuckGo",
};

export class WebToolsFlow {
  #client: WebToolsClient;
  #host: WebToolsFlowHost;
  #status: WebToolsStatus | undefined;
  #awaiting: "open" | "mutation" | undefined;

  constructor(client: WebToolsClient, host: WebToolsFlowHost) {
    this.#client = client;
    this.#host = host;
  }

  open(): void {
    if (this.#awaiting) {
      return;
    }
    this.#awaiting = "open";
    if (!this.#client.getWebToolsStatus()) {
      this.#awaiting = undefined;
      this.#host.showNotice("Could not request web tools settings");
    }
  }

  onStatus(status: WebToolsStatus, error?: string): void {
    this.#status = status;
    const awaiting = this.#awaiting;
    this.#awaiting = undefined;
    if (!awaiting) {
      return;
    }
    if (error) {
      this.#host.showPrompt();
      this.#host.showNotice(error);
      return;
    }
    if (awaiting === "mutation") {
      this.#host.showNotice("Web tools settings updated");
      return;
    }
    this.#showMenu();
  }

  #showMenu(): void {
    const status = this.#status;
    if (!status) {
      return;
    }
    const picker = new ChoicePicker("Web tools", [
      { value: "status", label: "View status" },
      ...(status.credentialSource === "sync"
        ? []
        : [
            { value: "add", label: "Add or replace API key" },
            { value: "remove", label: "Remove stored API key" },
          ]),
      ...(status.settingsSource === "sync" ? [] : [{ value: "primary", label: "Choose primary" }]),
    ]);
    picker.onAnswer = (choice) => {
      this.#host.showPrompt();
      switch (choice) {
        case "status":
          this.#appendStatus();
          return;
        case "add":
          this.#chooseCredentialProvider("add");
          return;
        case "remove":
          this.#chooseCredentialProvider("remove");
          return;
        case "primary":
          this.#choosePrimary();
          return;
        default:
          return;
      }
    };
    this.#host.showInteraction(picker);
  }

  #appendStatus(): void {
    const status = this.#status;
    if (!status) {
      return;
    }
    this.#host.append("");
    this.#host.append(`${GREEN}web_search available · web_fetch available${RESET}`);
    this.#host.append(`Primary: ${status.primary}`);
    if (status.settingsSource === "sync" || status.credentialSource === "sync") {
      this.#host.append("Managed by Cinba Sync");
    }
    this.#host.append(
      `Effective order: ${status.effectiveOrder.map((id) => PROVIDER_NAMES[id]).join(" → ")}`,
    );
    for (const provider of status.providers) {
      const state = provider.available ? "available" : "not configured";
      const source = provider.source ? ` · ${provider.source}` : "";
      const fallback = provider.bestEffort ? " · best-effort fallback" : "";
      this.#host.append(`${provider.name}: ${state}${source}${fallback}`);
    }
    this.#host.requestRender();
  }

  #chooseCredentialProvider(intent: "add" | "remove"): void {
    const status = this.#status;
    if (!status) {
      return;
    }
    const providers = status.providers.filter(
      (provider) =>
        provider.id !== "duckduckgo" && (intent === "add" || provider.hasStoredCredential),
    );
    if (providers.length === 0) {
      this.#host.showNotice("No stored web search API key can be removed");
      return;
    }
    const picker = new ChoicePicker(
      intent === "add" ? "Add a key for which provider?" : "Remove which stored key?",
      providers.map((provider) => ({
        value: provider.id,
        label: provider.name,
        description:
          intent === "remove" && provider.source === "environment"
            ? "the environment key will remain active"
            : provider.id,
      })),
    );
    picker.onAnswer = (provider) => {
      this.#host.showPrompt();
      if (provider !== "exa" && provider !== "brave") {
        return;
      }
      if (intent === "remove") {
        this.#submit(() => this.#client.clearWebToolsApiKey(provider));
        return;
      }
      this.#askForApiKey(provider);
    };
    this.#host.showInteraction(picker);
  }

  #askForApiKey(provider: WebSearchCredentialProviderId): void {
    const input = new SecretInput(`API key for ${provider}`);
    input.onAnswer = (apiKey) => {
      this.#host.showPrompt();
      if (apiKey) {
        this.#submit(() => this.#client.setWebToolsApiKey(provider, apiKey));
      }
    };
    this.#host.showInteraction(input);
  }

  #choosePrimary(): void {
    const primary = this.#status?.primary;
    const picker = new ChoicePicker("Primary web search provider", [
      { value: "auto", label: `${primary === "auto" ? "* " : "  "}Auto` },
      { value: "exa", label: `${primary === "exa" ? "* " : "  "}Exa` },
      { value: "brave", label: `${primary === "brave" ? "* " : "  "}Brave Search` },
    ]);
    picker.onAnswer = (choice) => {
      this.#host.showPrompt();
      if (choice === "auto" || choice === "exa" || choice === "brave") {
        this.#submit(() => this.#client.setWebSearchPrimary(choice));
      }
    };
    this.#host.showInteraction(picker);
  }

  #submit(send: () => boolean): void {
    if (this.#awaiting) {
      return;
    }
    if (!send()) {
      this.#host.showNotice("Could not send web tools settings");
      return;
    }
    this.#awaiting = "mutation";
  }
}
