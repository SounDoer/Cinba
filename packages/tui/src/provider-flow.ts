import { matchesKey, SelectList, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import type { ProviderStatus } from "@cinba/contract";
import { BOLD, DIM, GREEN, MAGENTA, RESET, SELECT_THEME, YELLOW } from "./theme.ts";

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

/** A provider chooser, including the filtering used for a long provider catalogue. */
class ProviderPicker implements Component {
  #list: SelectList;
  #title: string;
  #filter = "";
  onAnswer?: (providerId: string | undefined) => void;

  constructor(title: string, providers: ProviderStatus[], markConfigured: boolean) {
    this.#title = title;
    this.#list = new SelectList(
      providers.map((provider) => ({
        value: provider.id,
        label: `${markConfigured ? (provider.configured ? "* " : "  ") : ""}${provider.name}`,
        description: provider.id,
      })),
      10,
      SELECT_THEME,
    );
    this.#list.onSelect = (item) => this.onAnswer?.(item.value);
    this.#list.onCancel = () => this.onAnswer?.(undefined);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "backspace")) {
      this.#filter = this.#filter.slice(0, -1);
      this.#list.setFilter(this.#filter);
      return;
    }
    if (data.length === 1 && data >= " " && data !== "\x7f") {
      this.#filter += data;
      this.#list.setFilter(this.#filter);
      return;
    }
    this.#list.handleInput(data);
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  render(width: number): string[] {
    const typed = this.#filter === "" ? "" : `  ${MAGENTA}${this.#filter}${RESET}`;
    return [
      ...wrapTextWithAnsi(`${YELLOW}${BOLD}${this.#title}${RESET}${typed}`, width),
      ...this.#list.render(width),
      `${DIM}type to narrow, up/down to choose, Enter to confirm, Esc to cancel${RESET}`,
    ];
  }
}

/** A provider API-key input that never exposes the secret in terminal history. */
class ApiKeyInput implements Component, Focusable {
  #value = "";
  #providerId: string;
  focused = false;
  onAnswer?: (apiKey: string | undefined) => void;

  constructor(providerId: string) {
    this.#providerId = providerId;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.onAnswer?.(undefined);
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      this.onAnswer?.(this.#value.trim() === "" ? undefined : this.#value.trim());
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.#value = this.#value.slice(0, -1);
      return;
    }
    if (data.length > 0 && !data.startsWith("\x1b") && data >= " ") {
      this.#value += data;
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    return [
      ...wrapTextWithAnsi(`${YELLOW}${BOLD}API key for ${this.#providerId}${RESET}`, width),
      `${DIM}(nothing is echoed; Enter to save, Esc to cancel)${RESET}`,
      `> ${"*".repeat(Math.min(this.#value.length, Math.max(width - 4, 0)))}`,
    ];
  }
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
    if (!intent) return;

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

    const picker = new ProviderPicker(
      intent === "login" ? "Give which provider an API key?" : "Forget which provider's key?",
      choices,
      intent === "login",
    );
    picker.onAnswer = (providerId) => {
      this.#host.showPrompt();
      if (!providerId) return;
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
    if (!this.#client.listProviders()) this.#intent = undefined;
  }

  #askForApiKey(providerId: string): void {
    const input = new ApiKeyInput(providerId);
    input.onAnswer = (apiKey) => {
      this.#host.showPrompt();
      if (apiKey) this.#client.setApiKey(providerId, apiKey);
    };
    this.#host.showInteraction(input);
  }
}
