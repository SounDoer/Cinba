import type { Component } from "@earendil-works/pi-tui";
import { type CoreSyncControlClient, CoreSyncControlError } from "@cinba/core-client";
import type { CoreInstanceOverride, CoreSyncSources, CoreSyncView } from "@cinba/contract";
import { ChoicePicker, TextInput } from "./settings-components.ts";
import { DIM, GREEN, RESET, YELLOW } from "./theme.ts";

type OverrideChanges = {
  defaultModel?: CoreInstanceOverride["defaultModel"] | null;
  webTools?: CoreInstanceOverride["webTools"] | null;
};

export type SyncFlowHost = {
  append(line: string): void;
  showInteraction(component: Component): void;
  showPrompt(): void;
  requestRender(): void;
  showNotice(text: string): void;
};

const SOURCES: { value: string; label: string; sources: CoreSyncSources }[] = [
  {
    value: "local/local",
    label: "Local settings + local credentials (Dev default)",
    sources: { settings: "local", credentials: "local" },
  },
  {
    value: "sync/local",
    label: "Shared settings + local credentials",
    sources: { settings: "sync", credentials: "local" },
  },
  {
    value: "sync/sync",
    label: "Shared settings + shared credentials",
    sources: { settings: "sync", credentials: "sync" },
  },
];

export function describeCoreSync(view: CoreSyncView): string[] {
  const model = view.effective.defaultModel
    ? `${view.effective.defaultModel.provider}/${view.effective.defaultModel.id}`
    : "Pi default";
  return [
    `${GREEN}Sync ${view.state}${RESET}${view.syncRevision === undefined ? "" : ` · revision ${view.syncRevision}`}`,
    `Sources: ${view.sources.settings} settings + ${view.sources.credentials} credentials`,
    `Effective source: ${view.effectiveSettingsSource}`,
    `Default model: ${model}${view.override.defaultModel ? " (Core override)" : " (base setting)"}`,
    `Web Search: ${view.effective.webTools.searchPrimary}${view.override.webTools?.searchPrimary ? " (Core override)" : " (base setting)"}`,
    ...(view.errorCode ? [`${YELLOW}Last error: ${view.errorCode}${RESET}`] : []),
    ...(view.managementUrl ? [`Management: ${view.managementUrl}`] : []),
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof CoreSyncControlError
    ? error.message
    : "The Core could not complete the Sync operation";
}

export class SyncFlow {
  #client: CoreSyncControlClient;
  #host: SyncFlowHost;
  #view: CoreSyncView | undefined;
  #busy = false;

  constructor(client: CoreSyncControlClient, host: SyncFlowHost) {
    this.#client = client;
    this.#host = host;
  }

  async open(): Promise<void> {
    if (this.#busy) {
      return;
    }
    this.#busy = true;
    try {
      this.#view = await this.#client.status();
      this.#showMenu();
    } catch (error) {
      this.#host.showNotice(errorMessage(error));
    } finally {
      this.#busy = false;
    }
  }

  #showMenu(): void {
    const view = this.#view;
    if (!view) {
      return;
    }
    const choices = [
      { value: "status", label: "View status and effective settings" },
      ...(view.state === "disconnected" ? [{ value: "connect", label: "Connect to Sync" }] : []),
      ...(view.state === "pending" ? [{ value: "cancel", label: "Cancel enrollment" }] : []),
      ...(view.state !== "disconnected" && view.state !== "pending"
        ? [
            { value: "now", label: "Sync now" },
            { value: "sources", label: "Change settings and credential sources" },
            { value: "disconnect", label: "Disconnect this Core" },
          ]
        : []),
      { value: "model", label: "Override default model for this Core" },
      { value: "search", label: "Override Web Search for this Core" },
      { value: "reset", label: "Reset overrides to shared/base settings" },
      ...(view.managementUrl ? [{ value: "management", label: "Show Sync management URL" }] : []),
    ];
    const picker = new ChoicePicker("Sync for this Core", choices);
    picker.onAnswer = (choice) => {
      this.#host.showPrompt();
      switch (choice) {
        case "status":
          this.#appendStatus();
          break;
        case "connect":
          this.#askServerUrl();
          break;
        case "cancel":
          void this.#run(() => this.#client.cancelEnrollment(), "Enrollment cancelled");
          break;
        case "now":
          void this.#run(() => this.#client.syncNow(), "Sync completed");
          break;
        case "sources":
          this.#chooseSources(
            (sources) =>
              void this.#run(() => this.#client.updateSources(sources), "Sources updated"),
          );
          break;
        case "disconnect":
          void this.#run(() => this.#client.disconnect(), "Core disconnected from Sync");
          break;
        case "model":
          this.#askModelProvider();
          break;
        case "search":
          this.#chooseSearchOverride();
          break;
        case "reset":
          void this.#run(() => this.#client.updateOverride({}), "Core overrides reset");
          break;
        case "management":
          this.#host.append(`Sync management: ${view.managementUrl}`);
          this.#host.requestRender();
          break;
      }
    };
    this.#host.showInteraction(picker);
  }

  #appendStatus(): void {
    if (!this.#view) {
      return;
    }
    this.#host.append("");
    for (const line of describeCoreSync(this.#view)) {
      this.#host.append(line);
    }
    if (this.#view.state === "pending" && this.#view.enrollmentExpiresAt) {
      this.#host.append(`${DIM}Enrollment expires ${this.#view.enrollmentExpiresAt}${RESET}`);
    }
    this.#host.requestRender();
  }

  #askServerUrl(): void {
    const input = new TextInput("Sync Server URL");
    input.onAnswer = (serverUrl) => {
      this.#host.showPrompt();
      if (serverUrl) {
        this.#chooseSources(
          (sources) =>
            void this.#run(() => this.#client.connect(serverUrl, sources), "Enrollment requested"),
        );
      }
    };
    this.#host.showInteraction(input);
  }

  #chooseSources(onAnswer: (sources: CoreSyncSources) => void): void {
    const picker = new ChoicePicker(
      "Settings and credential source",
      SOURCES.map(({ value, label }) => ({ value, label })),
    );
    picker.onAnswer = (value) => {
      this.#host.showPrompt();
      const choice = SOURCES.find((candidate) => candidate.value === value);
      if (choice) {
        onAnswer(choice.sources);
      }
    };
    this.#host.showInteraction(picker);
  }

  #askModelProvider(): void {
    const input = new TextInput("Provider ID", this.#view?.override.defaultModel?.provider ?? "");
    input.onAnswer = (provider) => {
      this.#host.showPrompt();
      if (!provider) {
        return;
      }
      const modelInput = new TextInput("Model ID", this.#view?.override.defaultModel?.id ?? "");
      modelInput.onAnswer = (id) => {
        this.#host.showPrompt();
        if (id) {
          void this.#saveOverride({ defaultModel: { provider, id } });
        }
      };
      this.#host.showInteraction(modelInput);
    };
    this.#host.showInteraction(input);
  }

  #chooseSearchOverride(): void {
    const picker = new ChoicePicker("Web Search override", [
      { value: "shared", label: "Use shared/base setting" },
      { value: "auto", label: "Auto" },
      { value: "exa", label: "Exa" },
      { value: "brave", label: "Brave Search" },
    ]);
    picker.onAnswer = (value) => {
      this.#host.showPrompt();
      if (value === "shared") {
        void this.#saveOverride({ webTools: null });
      }
      if (value === "auto" || value === "exa" || value === "brave") {
        void this.#saveOverride({ webTools: { searchPrimary: value } });
      }
    };
    this.#host.showInteraction(picker);
  }

  async #saveOverride(changes: OverrideChanges): Promise<void> {
    const current = this.#view?.override ?? {};
    const next: CoreInstanceOverride = {};
    const defaultModel = Object.hasOwn(changes, "defaultModel")
      ? changes.defaultModel
      : current.defaultModel;
    const webTools = Object.hasOwn(changes, "webTools") ? changes.webTools : current.webTools;
    if (defaultModel) {
      next.defaultModel = defaultModel;
    }
    if (webTools) {
      next.webTools = webTools;
    }
    await this.#run(() => this.#client.updateOverride(next), "Core override updated");
  }

  async #run(operation: () => Promise<unknown>, success: string): Promise<void> {
    if (this.#busy) {
      return;
    }
    this.#busy = true;
    try {
      await operation();
      this.#view = await this.#client.status();
      this.#host.showNotice(success);
    } catch (error) {
      this.#host.showNotice(errorMessage(error));
    } finally {
      this.#busy = false;
    }
  }
}
