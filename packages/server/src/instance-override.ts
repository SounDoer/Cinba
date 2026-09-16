import type { ModelRef, WebSearchPrimary } from "@cinba/contract";
import { type StoredJsonError, loadStoredJson, writeAtomicJson } from "./atomic-json-store.ts";
import { type InstanceOverride, isModelRef, isWebSearchPrimary } from "./effective-settings.ts";

const VERSION = 1;

export type InstanceOverrideStore = {
  get(): InstanceOverride;
  setDefaultModel(model: ModelRef | undefined): void;
  setWebSearchPrimary(primary: WebSearchPrimary | undefined): void;
  replace(override: InstanceOverride): void;
  reset(): void;
  problem(): StoredJsonError | undefined;
};

function parseOverride(value: unknown): InstanceOverride {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an override object");
  }
  const document = value as Record<string, unknown>;
  if (document.version !== VERSION) {
    throw new Error("unsupported Instance Override version");
  }
  if (document.defaultModel !== undefined && !isModelRef(document.defaultModel)) {
    throw new Error("invalid default model override");
  }
  let webTools: InstanceOverride["webTools"];
  if (document.webTools !== undefined) {
    if (typeof document.webTools !== "object" || document.webTools === null) {
      throw new Error("invalid Web tools override");
    }
    const candidate = document.webTools as Record<string, unknown>;
    if (candidate.searchPrimary !== undefined && !isWebSearchPrimary(candidate.searchPrimary)) {
      throw new Error("invalid Web Search override");
    }
    if (candidate.searchPrimary !== undefined) {
      webTools = { searchPrimary: candidate.searchPrimary };
    }
  }
  return {
    ...(document.defaultModel ? { defaultModel: document.defaultModel as ModelRef } : {}),
    ...(webTools ? { webTools } : {}),
  };
}

function serialize(override: InstanceOverride): unknown {
  return {
    version: VERSION,
    ...(override.defaultModel ? { defaultModel: override.defaultModel } : {}),
    ...(override.webTools?.searchPrimary
      ? { webTools: { searchPrimary: override.webTools.searchPrimary } }
      : {}),
  };
}

export function createInstanceOverrideStore(path: string): InstanceOverrideStore {
  const loaded = loadStoredJson(path, parseOverride);
  let state: InstanceOverride = loaded.status === "valid" ? loaded.value : {};
  const loadProblem = loaded.status === "invalid" ? loaded.error : undefined;

  function commit(next: InstanceOverride): void {
    if (loadProblem) {
      throw loadProblem;
    }
    writeAtomicJson(path, serialize(next), parseOverride);
    state = next;
  }

  return {
    get: () => ({
      ...(state.defaultModel ? { defaultModel: { ...state.defaultModel } } : {}),
      ...(state.webTools ? { webTools: { ...state.webTools } } : {}),
    }),
    setDefaultModel: (defaultModel) =>
      commit({
        ...(defaultModel ? { defaultModel: { ...defaultModel } } : {}),
        ...(state.webTools ? { webTools: { ...state.webTools } } : {}),
      }),
    setWebSearchPrimary: (searchPrimary) =>
      commit({
        ...(state.defaultModel ? { defaultModel: { ...state.defaultModel } } : {}),
        ...(searchPrimary ? { webTools: { searchPrimary } } : {}),
      }),
    replace: (override) => commit(parseOverride(serialize(override))),
    reset: () => commit({}),
    problem: () => loadProblem,
  };
}
