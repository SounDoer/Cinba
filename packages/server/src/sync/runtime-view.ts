import {
  type EffectiveSettings,
  type InstanceOverride,
  type Settings,
  type SourceSelection,
  resolveEffectiveSettings,
} from "../effective-settings.ts";

export type SyncSettingsResolution = {
  settings: EffectiveSettings;
  source: "local" | "sync" | "local-fallback";
};

export function resolveSyncSettings(options: {
  sources: SourceSelection;
  local: Settings;
  shared?: Settings;
  override: InstanceOverride;
}): SyncSettingsResolution {
  if (options.sources.settings === "sync" && !options.shared) {
    return {
      settings: resolveEffectiveSettings({
        sources: { settings: "local", credentials: "local" },
        local: options.local,
        override: options.override,
      }),
      source: "local-fallback",
    };
  }
  return {
    settings: resolveEffectiveSettings(options),
    source: options.sources.settings,
  };
}
