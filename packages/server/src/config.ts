// Persistent settings for one Cinba service.
// This module owns both their in-memory state and their on-disk representation.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelRef } from "@cinba/contract";

export type WebSearchPrimary = "auto" | "exa" | "brave";

export type CinbaConfig = {
  cwd: string;
  model: ModelRef | undefined;
  lastSessionId: string | undefined;
  coreName: string;
  webSearchPrimary: WebSearchPrimary;
};

export type ConfigStore = {
  /** Return a copy so callers cannot bypass update() and persistence. */
  get(): CinbaConfig;
  /** Change memory and persist the complete current state as one operation. */
  update(changes: Partial<CinbaConfig>): void;
};

type ConfigDefaults = Pick<CinbaConfig, "cwd" | "coreName">;

/** Load and own one config file. A missing or malformed file means defaults. */
export function createConfigStore(path: string, defaults: ConfigDefaults): ConfigStore {
  let state: CinbaConfig = {
    cwd: defaults.cwd,
    model: undefined,
    lastSessionId: undefined,
    coreName: defaults.coreName,
    webSearchPrimary: "auto",
  };

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof parsed.cwd === "string" && existsSync(parsed.cwd)) {
      state.cwd = parsed.cwd;
    }
    if (typeof parsed.provider === "string" && typeof parsed.modelId === "string") {
      state.model = { provider: parsed.provider, id: parsed.modelId };
    }
    if (typeof parsed.lastSessionId === "string") {
      state.lastSessionId = parsed.lastSessionId;
    }
    if (typeof parsed.coreName === "string" && parsed.coreName.trim() !== "") {
      state.coreName = parsed.coreName.trim();
    }
    if (
      parsed.webSearchPrimary === "auto" ||
      parsed.webSearchPrimary === "exa" ||
      parsed.webSearchPrimary === "brave"
    ) {
      state.webSearchPrimary = parsed.webSearchPrimary;
    }
  } catch {
    // First start, an unreadable file, and malformed JSON all fall back safely.
  }

  function get(): CinbaConfig {
    return { ...state, model: state.model ? { ...state.model } : undefined };
  }

  function update(changes: Partial<CinbaConfig>): void {
    if (changes.cwd !== undefined) {
      state.cwd = changes.cwd;
    }
    if (Object.hasOwn(changes, "model")) {
      state.model = changes.model ? { ...changes.model } : undefined;
    }
    if (Object.hasOwn(changes, "lastSessionId")) {
      state.lastSessionId = changes.lastSessionId;
    }
    if (changes.coreName !== undefined) {
      state.coreName = changes.coreName;
    }
    if (changes.webSearchPrimary !== undefined) {
      state.webSearchPrimary = changes.webSearchPrimary;
    }

    try {
      mkdirSync(dirname(path), { recursive: true });
      const body = {
        cwd: state.cwd,
        provider: state.model?.provider,
        modelId: state.model?.id,
        lastSessionId: state.lastSessionId,
        coreName: state.coreName,
        webSearchPrimary: state.webSearchPrimary,
      };
      writeFileSync(path, JSON.stringify(body, null, 2), "utf8");
    } catch {
      // Failing to remember does not affect this run or interrupt the service.
    }
  }

  return { get, update };
}
