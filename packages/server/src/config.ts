// Persistent local facts for one Core instance. User preferences live in
// local-settings.json and instance-override.json, never in this store.

import { existsSync } from "node:fs";
import type { WebSearchPrimary } from "@cinba/contract";
import { type StoredJsonError, loadStoredJson, writeAtomicJson } from "./atomic-json-store.ts";

export type LocalState = {
  cwd: string;
  lastSessionId: string | undefined;
  coreName: string;
};

export type LocalStateStore = {
  get(): LocalState;
  update(changes: Partial<LocalState>): void;
  problem(): StoredJsonError | undefined;
};

type LocalStateDefaults = Pick<LocalState, "cwd" | "coreName">;

// Kept only so an old config document is not destructively rewritten during
// the no-automatic-migration transition. These values are never consumed.
type LegacySettings = {
  provider?: string;
  modelId?: string;
  webSearchPrimary?: WebSearchPrimary;
};

function parseLocalState(value: unknown, defaults: LocalStateDefaults): LocalState {
  const document = value as Record<string, unknown>;
  return {
    cwd: typeof document.cwd === "string" && existsSync(document.cwd) ? document.cwd : defaults.cwd,
    lastSessionId: typeof document.lastSessionId === "string" ? document.lastSessionId : undefined,
    coreName:
      typeof document.coreName === "string" && document.coreName.trim() !== ""
        ? document.coreName.trim()
        : defaults.coreName,
  };
}

function legacySettings(document: Record<string, unknown>): LegacySettings {
  const settings: LegacySettings = {};
  if (typeof document.provider === "string") {
    settings.provider = document.provider;
  }
  if (typeof document.modelId === "string") {
    settings.modelId = document.modelId;
  }
  if (
    document.webSearchPrimary === "auto" ||
    document.webSearchPrimary === "exa" ||
    document.webSearchPrimary === "brave"
  ) {
    settings.webSearchPrimary = document.webSearchPrimary;
  }
  return settings;
}

/** Load and own only cwd, Core name, and last-session state. */
export function createLocalStateStore(path: string, defaults: LocalStateDefaults): LocalStateStore {
  const loaded = loadStoredJson(path, (value) => parseLocalState(value, defaults));
  let state: LocalState =
    loaded.status === "valid"
      ? loaded.value
      : { cwd: defaults.cwd, lastSessionId: undefined, coreName: defaults.coreName };
  const preserved = loaded.status === "valid" ? legacySettings(loaded.document) : {};
  const loadProblem = loaded.status === "invalid" ? loaded.error : undefined;

  function get(): LocalState {
    return { ...state };
  }

  function update(changes: Partial<LocalState>): void {
    if (loadProblem) {
      throw loadProblem;
    }
    const next: LocalState = {
      cwd: changes.cwd ?? state.cwd,
      coreName: changes.coreName?.trim() || state.coreName,
      lastSessionId: Object.hasOwn(changes, "lastSessionId")
        ? changes.lastSessionId
        : state.lastSessionId,
    };
    const document = { ...preserved, ...next };
    writeAtomicJson(path, document, (value) => parseLocalState(value, defaults));
    state = next;
  }

  return { get, update, problem: () => loadProblem };
}
