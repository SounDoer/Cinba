import type { Component } from "@earendil-works/pi-tui";
import { type CoreSyncControlClient, CoreSyncControlError } from "@cinba/core-client";
import type { CoreInstanceOverride, CoreSyncSources, CoreSyncView } from "@cinba/contract";
import type { ServiceMode } from "@cinba/installer";
import {
  type ProductSyncHostStatus,
  formatProductSyncHostStatus,
  inspectProductSyncHost,
} from "@cinba/product-runtime/sync-host-manager";
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

export type SyncFlowCoreClient = Pick<
  CoreSyncControlClient,
  | "status"
  | "cancelEnrollment"
  | "syncNow"
  | "updateSources"
  | "disconnect"
  | "connect"
  | "updateOverride"
>;

export type SyncHostManager = {
  inspect(): Promise<ProductSyncHostStatus>;
  create?(publicOrigin?: string): Promise<{
    status: ProductSyncHostStatus;
    setupCode?: string;
  }>;
  configure?(publicOrigin: string): Promise<ProductSyncHostStatus>;
  setMode?(mode: ServiceMode): Promise<ProductSyncHostStatus>;
  delete?(): Promise<ProductSyncHostStatus>;
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
  #client: SyncFlowCoreClient;
  #host: SyncFlowHost;
  #hostManager: SyncHostManager;
  #view: CoreSyncView | undefined;
  #hostStatus: ProductSyncHostStatus | undefined;
  #busy = false;

  constructor(
    client: SyncFlowCoreClient,
    host: SyncFlowHost,
    hostManager: SyncHostManager = { inspect: inspectProductSyncHost },
  ) {
    this.#client = client;
    this.#host = host;
    this.#hostManager = hostManager;
  }

  async open(): Promise<void> {
    if (this.#busy) {
      return;
    }
    this.#busy = true;
    try {
      [this.#view, this.#hostStatus] = await Promise.all([
        this.#client.status(),
        this.#hostManager.inspect(),
      ]);
      this.#showSectionMenu();
    } catch (error) {
      this.#host.showNotice(errorMessage(error));
    } finally {
      this.#busy = false;
    }
  }

  #showSectionMenu(): void {
    const status = this.#hostStatus;
    if (!status) {
      return;
    }
    let hostState = "created";
    if (status.state === "repair-required") {
      hostState = "repair required";
    } else if (status.state === "not-created") {
      hostState = "not created";
    }
    const picker = new ChoicePicker("Cinba Sync", [
      { value: "core", label: "This Core" },
      { value: "host", label: `Sync Host on this device · ${hostState}` },
    ]);
    picker.onAnswer = (choice) => {
      this.#host.showPrompt();
      if (choice === "core") {
        this.#showCoreMenu();
      }
      if (choice === "host") {
        this.#showHostMenu();
      }
    };
    this.#host.showInteraction(picker);
  }

  #showCoreMenu(): void {
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

  #showHostMenu(): void {
    if (!this.#hostStatus) {
      return;
    }
    const picker = new ChoicePicker("Sync Host on this device", [
      { value: "status", label: "View Host status" },
      ...(this.#hostStatus.state === "not-created" && this.#hostManager.create
        ? [{ value: "create", label: "Create Sync Host on this device" }]
        : []),
      ...(this.#hostStatus.state === "created" && this.#hostManager.configure
        ? [{ value: "configure", label: "Configure public origin" }]
        : []),
      ...(this.#hostStatus.state === "created" && this.#hostManager.setMode
        ? [
            { value: "mode", label: "Change lifecycle mode" },
            { value: "disable", label: "Disable Sync Host" },
          ]
        : []),
      ...(this.#hostStatus.state === "created" && this.#hostManager.delete
        ? [{ value: "delete", label: "Delete Sync Host permanently" }]
        : []),
    ]);
    picker.onAnswer = (choice) => {
      this.#host.showPrompt();
      if (choice === "status" && this.#hostStatus) {
        this.#host.append("");
        for (const line of formatProductSyncHostStatus(this.#hostStatus).split("\n")) {
          this.#host.append(line);
        }
        this.#host.requestRender();
      }
      if (choice === "create") {
        this.#confirmHostCreation();
      }
      if (choice === "configure") {
        this.#confirmHostConfiguration();
      }
      if (choice === "mode") {
        this.#chooseHostMode();
      }
      if (choice === "disable") {
        this.#confirmHostDisable();
      }
      if (choice === "delete") {
        this.#confirmHostDelete();
      }
    };
    this.#host.showInteraction(picker);
  }

  #confirmHostDelete(): void {
    const connectedCores =
      this.#hostStatus?.state === "created" && this.#hostStatus.connectedCoreCount !== null
        ? String(this.#hostStatus.connectedCoreCount)
        : "unknown";
    const picker = new ChoicePicker(
      `Delete Sync Host permanently — ${connectedCores} connected Cores; removes authority, Shared Settings, Credentials, and history`,
      [{ value: "continue", label: "Continue to typed confirmation" }],
    );
    picker.onAnswer = (choice) => {
      this.#host.showPrompt();
      if (choice === "continue") {
        this.#askHostDeletePhrase();
      }
    };
    this.#host.showInteraction(picker);
  }

  #askHostDeletePhrase(): void {
    const input = new TextInput('Type "DELETE SYNC HOST" to continue');
    input.onAnswer = (answer) => {
      this.#host.showPrompt();
      if (answer === "DELETE SYNC HOST") {
        void this.#deleteHost();
      } else if (answer !== undefined) {
        this.#host.showNotice("Sync Host deletion cancelled");
      }
    };
    this.#host.showInteraction(input);
  }

  async #deleteHost(): Promise<void> {
    if (this.#busy || !this.#hostManager.delete) {
      return;
    }
    this.#busy = true;
    try {
      this.#hostStatus = await this.#hostManager.delete();
      this.#view = await this.#client.status();
      this.#host.showNotice("Sync Host deleted permanently");
    } catch (error) {
      this.#host.showNotice(
        error instanceof Error ? error.message : "The Sync Host could not be deleted",
      );
    } finally {
      this.#busy = false;
    }
  }

  #confirmHostDisable(): void {
    const picker = new ChoicePicker(
      "Disable Sync Host — service stops, but Host configuration and authority are kept",
      [{ value: "disable", label: "Disable and keep Host data" }],
    );
    picker.onAnswer = (choice) => {
      this.#host.showPrompt();
      if (choice === "disable") {
        void this.#setHostMode("disabled");
      }
    };
    this.#host.showInteraction(picker);
  }

  #confirmHostConfiguration(): void {
    const picker = new ChoicePicker(
      "Change public origin — management sign-in and connected Cores may need to reconnect",
      [{ value: "continue", label: "Continue" }],
    );
    picker.onAnswer = (choice) => {
      this.#host.showPrompt();
      if (choice === "continue") {
        this.#askConfiguredHostPublicOrigin();
      }
    };
    this.#host.showInteraction(picker);
  }

  #askConfiguredHostPublicOrigin(): void {
    const currentOrigin =
      this.#hostStatus?.state === "created" ? this.#hostStatus.publicOrigin : "";
    const input = new TextInput("Public HTTPS origin", currentOrigin);
    input.onAnswer = (publicOrigin) => {
      this.#host.showPrompt();
      if (publicOrigin) {
        void this.#configureHost(publicOrigin);
      }
    };
    this.#host.showInteraction(input);
  }

  async #configureHost(publicOrigin: string): Promise<void> {
    if (this.#busy || !this.#hostManager.configure) {
      return;
    }
    this.#busy = true;
    try {
      this.#hostStatus = await this.#hostManager.configure(publicOrigin);
      this.#host.showNotice("Sync Host public origin updated");
    } catch (error) {
      this.#host.showNotice(
        error instanceof Error ? error.message : "The Sync Host origin could not be changed",
      );
    } finally {
      this.#busy = false;
    }
  }

  #confirmHostCreation(): void {
    const picker = new ChoicePicker(
      "Create Sync Host — current Settings initialize Shared Settings; Credentials stay local",
      [
        {
          value: "continue",
          label: "Continue",
          description: "API Credentials are not uploaded.",
        },
      ],
    );
    picker.onAnswer = (choice) => {
      this.#host.showPrompt();
      if (choice === "continue") {
        this.#askHostPublicOrigin();
      }
    };
    this.#host.showInteraction(picker);
  }

  #askHostPublicOrigin(): void {
    const input = new TextInput("Public HTTPS origin (leave blank for this device only)");
    input.onAnswer = (publicOrigin) => {
      this.#host.showPrompt();
      void this.#createHost(publicOrigin);
    };
    this.#host.showInteraction(input);
  }

  async #createHost(publicOrigin: string | undefined): Promise<void> {
    if (this.#busy || !this.#hostManager.create) {
      return;
    }
    this.#busy = true;
    try {
      const creation = await this.#hostManager.create(publicOrigin);
      this.#hostStatus = creation.status;
      this.#view = await this.#client.status();
      this.#host.showNotice("Sync Host created");
      if (creation.setupCode) {
        this.#host.append(`Setup Code: ${creation.setupCode}`);
        this.#host.requestRender();
      }
      this.#chooseHostMode();
    } catch (error) {
      this.#host.showNotice(
        error instanceof Error ? error.message : "The Sync Host could not be created",
      );
    } finally {
      this.#busy = false;
    }
  }

  #chooseHostMode(): void {
    if (!this.#hostManager.setMode) {
      return;
    }
    const picker = new ChoicePicker("How should this Sync Host run?", [
      {
        value: "background",
        label: "Background (VPS recommended)",
        description: "Keep running after SSH exits; Linux may require linger.",
      },
      {
        value: "on-demand",
        label: "On-demand",
        description: "Run only while a local Cinba surface needs it.",
      },
    ]);
    picker.onAnswer = (choice) => {
      this.#host.showPrompt();
      if (choice === "background" || choice === "on-demand") {
        void this.#setHostMode(choice);
      }
    };
    this.#host.showInteraction(picker);
  }

  async #setHostMode(mode: ServiceMode): Promise<void> {
    if (this.#busy || !this.#hostManager.setMode) {
      return;
    }
    this.#busy = true;
    try {
      this.#hostStatus = await this.#hostManager.setMode(mode);
      this.#host.showNotice(`Sync Host mode changed to ${mode}`);
    } catch (error) {
      this.#host.showNotice(
        error instanceof Error ? error.message : "The Sync Host mode could not be changed",
      );
    } finally {
      this.#busy = false;
    }
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
