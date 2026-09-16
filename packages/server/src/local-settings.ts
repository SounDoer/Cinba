import type { ModelRef, WebSearchPrimary } from "@cinba/contract";
import { type StoredJsonError, loadStoredJson, writeAtomicJson } from "./atomic-json-store.ts";
import { type Settings, isModelRef, isWebSearchPrimary } from "./effective-settings.ts";

const VERSION = 1;

export type LocalSettingsStore = {
  get(): Settings;
  setDefaultModel(model: ModelRef | undefined): void;
  setWebSearchPrimary(primary: WebSearchPrimary): void;
  problem(): StoredJsonError | undefined;
};

function parseSettings(value: unknown): Settings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a settings object");
  }
  const document = value as Record<string, unknown>;
  if (document.version !== VERSION) {
    throw new Error("unsupported Local Settings version");
  }
  if (typeof document.webTools !== "object" || document.webTools === null) {
    throw new Error("missing webTools settings");
  }
  const webTools = document.webTools as Record<string, unknown>;
  if (!isWebSearchPrimary(webTools.searchPrimary)) {
    throw new Error("invalid Web Search primary");
  }
  if (document.defaultModel !== undefined && !isModelRef(document.defaultModel)) {
    throw new Error("invalid default model");
  }
  return {
    defaultModel: document.defaultModel as ModelRef | undefined,
    webTools: { searchPrimary: webTools.searchPrimary },
  };
}

function serialize(settings: Settings): unknown {
  return {
    version: VERSION,
    ...(settings.defaultModel ? { defaultModel: settings.defaultModel } : {}),
    webTools: settings.webTools,
  };
}

export function createLocalSettingsStore(path: string): LocalSettingsStore {
  const loaded = loadStoredJson(path, parseSettings);
  let state: Settings =
    loaded.status === "valid"
      ? loaded.value
      : { defaultModel: undefined, webTools: { searchPrimary: "auto" } };
  const loadProblem = loaded.status === "invalid" ? loaded.error : undefined;

  function commit(next: Settings): void {
    if (loadProblem) {
      throw loadProblem;
    }
    writeAtomicJson(path, serialize(next), parseSettings);
    state = next;
  }

  return {
    get: () => ({
      defaultModel: state.defaultModel ? { ...state.defaultModel } : undefined,
      webTools: { ...state.webTools },
    }),
    setDefaultModel: (defaultModel) =>
      commit({
        defaultModel: defaultModel ? { ...defaultModel } : undefined,
        webTools: { ...state.webTools },
      }),
    setWebSearchPrimary: (searchPrimary) =>
      commit({
        defaultModel: state.defaultModel ? { ...state.defaultModel } : undefined,
        webTools: { searchPrimary },
      }),
    problem: () => loadProblem,
  };
}
