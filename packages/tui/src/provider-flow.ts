import type { Component } from "@earendil-works/pi-tui";
import type { ProviderStatus } from "@cinba/contract";
import { ChoicePicker, SecretInput } from "./settings-components.ts";
import { DIM, GREEN, RESET } from "./theme.ts";

type ProviderIntent = "list" | "login" | "logout";

export type ProviderClient = {
  listProviders(): boolean;
  setApiKey(providerId: string, apiKey: string): boolean;
  clearCredential(providerId: string): boolean;
};

export type ProviderFlowHost = {
  append(line: string): void;
  showInteraction(component: Component): void;
  showPrompt(): void;
  requestRender(): void;
  showNotice(text: string): void;
};

function providerLabel(provider: ProviderStatus, markConfigured: boolean): string {
  if (!markConfigured) {
    return provider.name;
  }
  const marker = provider.configured ? "* " : "  ";
  return `${marker}${provider.name}`;
}

/** Owns the complete /providers, /login, and /logout user flow. */
export class ProviderFlow {
  #intent: ProviderIntent | undefined;
  #client: ProviderClient;
  #host: ProviderFlowHost;

  constructor(client: ProviderClient, host: ProviderFlowHost) {
    this.#client = client;
    this.#host = host;
  }

  list(): void {
    this.#request("list");
  }

  login(): void {
    this.#request("login");
  }

  logout(): void {
    this.#request("logout");
  }

  onListing(providers: ProviderStatus[]): void {
    const intent = this.#intent;
    this.#intent = undefined;
    if (!intent) {
      return;
    }

    if (intent === "list") {
      this.#host.append("");
      for (const provider of providers.filter((entry) => entry.configured)) {
        this.#host.append(
          `${GREEN}configured${RESET}  ${provider.name} ${DIM}(${provider.id})${RESET}`,
        );
      }
      this.#host.append(
        `${DIM}${providers.filter((entry) => !entry.configured).length} more available - /login to add one${RESET}`,
      );
      this.#host.requestRender();
      return;
    }

    const choices =
      intent === "logout" ? providers.filter((provider) => provider.configured) : providers;
    if (intent === "logout" && choices.length === 0) {
      this.#host.showNotice("nothing is configured");
      return;
    }

    const picker = new ChoicePicker(
      intent === "login" ? "Give which provider an API key?" : "Forget which provider's key?",
      choices.map((provider) => ({
        value: provider.id,
        label: providerLabel(provider, intent === "login"),
        description: provider.id,
      })),
    );
    picker.onAnswer = (providerId) => {
      this.#host.showPrompt();
      if (!providerId) {
        return;
      }
      if (intent === "logout") {
        this.#client.clearCredential(providerId);
        return;
      }
      this.#askForApiKey(providerId);
    };
    this.#host.showInteraction(picker);
  }

  #request(intent: ProviderIntent): void {
    this.#intent = intent;
    if (!this.#client.listProviders()) {
      this.#intent = undefined;
    }
  }

  #askForApiKey(providerId: string): void {
    const input = new SecretInput(`API key for ${providerId}`);
    input.onAnswer = (apiKey) => {
      this.#host.showPrompt();
      if (apiKey) {
        this.#client.setApiKey(providerId, apiKey);
      }
    };
    this.#host.showInteraction(input);
  }
}
