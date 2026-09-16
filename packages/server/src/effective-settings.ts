import type { ModelRef, WebSearchPrimary } from "@cinba/contract";

export type SettingsSource = "local" | "sync";
export type CredentialSource = "local" | "sync";

export type SourceSelection = {
  settings: SettingsSource;
  credentials: CredentialSource;
};

export const LOCAL_SOURCES: SourceSelection = { settings: "local", credentials: "local" };

export type Settings = {
  defaultModel: ModelRef | undefined;
  webTools: {
    searchPrimary: WebSearchPrimary;
  };
};

export type InstanceOverride = {
  defaultModel?: ModelRef;
  webTools?: {
    searchPrimary?: WebSearchPrimary;
  };
};

export type EffectiveSettings = Settings;

export function isModelRef(value: unknown): value is ModelRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.provider === "string" &&
    candidate.provider.trim() !== "" &&
    typeof candidate.id === "string" &&
    candidate.id.trim() !== ""
  );
}

export function isWebSearchPrimary(value: unknown): value is WebSearchPrimary {
  return value === "auto" || value === "exa" || value === "brave";
}

export function assertSupportedSources(selection: SourceSelection): void {
  if (selection.settings === "local" && selection.credentials === "sync") {
    throw new Error("Local Settings cannot use Shared Credentials");
  }
}

export function resolveEffectiveSettings(options: {
  sources: SourceSelection;
  local: Settings;
  shared?: Settings;
  override: InstanceOverride;
}): EffectiveSettings {
  assertSupportedSources(options.sources);
  const base = options.sources.settings === "local" ? options.local : options.shared;
  if (!base) {
    throw new Error("Shared Settings are not available");
  }
  return {
    defaultModel: options.override.defaultModel ?? base.defaultModel,
    webTools: {
      searchPrimary: options.override.webTools?.searchPrimary ?? base.webTools.searchPrimary,
    },
  };
}

export function resolveInitialModel(
  explicit: ModelRef | undefined,
  effective: EffectiveSettings,
): ModelRef | undefined {
  return explicit ?? effective.defaultModel;
}
