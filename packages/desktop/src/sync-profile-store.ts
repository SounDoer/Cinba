import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { type SyncProfile, createSyncProfile } from "./sync-profile.ts";

export type SyncProfileStore = {
  get(): SyncProfile | undefined;
  set(baseUrl: string): SyncProfile;
  clear(): void;
  subscribe(listener: (profile: SyncProfile | undefined) => void): () => void;
};

export function createSyncProfileStore(path: string): SyncProfileStore {
  let profile: SyncProfile | undefined;
  if (existsSync(path)) {
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (document.version !== 1 || typeof document.baseUrl !== "string") {
      throw new Error(`Cannot read Desktop Sync profile from ${path}`);
    }
    profile = createSyncProfile(document.baseUrl);
  }
  const listeners = new Set<(profile: SyncProfile | undefined) => void>();

  function save(next: SyncProfile | undefined): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!next) {
      if (existsSync(path)) {
        unlinkSync(path);
      }
      profile = undefined;
    } else {
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(
          temporary,
          `${JSON.stringify({ version: 1, baseUrl: next.baseUrl }, null, 2)}\n`,
          {
            mode: 0o600,
          },
        );
        renameSync(temporary, path);
        profile = next;
      } catch (error) {
        if (existsSync(temporary)) {
          unlinkSync(temporary);
        }
        throw error;
      }
    }
    for (const listener of listeners) {
      listener(profile ? { ...profile } : undefined);
    }
  }

  return {
    get: () => (profile ? { ...profile } : undefined),
    set: (baseUrl) => {
      const next = createSyncProfile(baseUrl);
      save(next);
      return { ...next };
    },
    clear: () => save(undefined),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
