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
import {
  type CoreProfile,
  type RemoteCoreProfile,
  type RemoteCoreProfileInput,
  createRemoteCoreProfile,
} from "./profiles.ts";

export type CoreProfileStore = {
  list(): CoreProfile[];
  add(input: RemoteCoreProfileInput): RemoteCoreProfile;
  update(id: string, input: RemoteCoreProfileInput): RemoteCoreProfile;
  remove(id: string): void;
  select(id: string): void;
  lastSelected(): CoreProfile;
  problem(): string | undefined;
  canRecover(): boolean;
  recover(): string;
  subscribe(listener: (profiles: CoreProfile[]) => void): () => void;
};

function parseStoredRemoteProfile(value: unknown): RemoteCoreProfile | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== "remote" ||
    typeof candidate.id !== "string" ||
    candidate.id === "local" ||
    typeof candidate.label !== "string" ||
    typeof candidate.baseUrl !== "string"
  ) {
    return undefined;
  }
  const id = candidate.id;
  try {
    return createRemoteCoreProfile(
      { label: candidate.label, baseUrl: candidate.baseUrl },
      () => id,
    );
  } catch {
    return undefined;
  }
}

export function createCoreProfileStore(
  path: string,
  options: {
    createId?: () => string;
    localLabel?: string;
    writeDocument?: (path: string, body: string) => void;
    replaceDocument?: (from: string, to: string) => void;
  } = {},
): CoreProfileStore {
  const local: CoreProfile = {
    id: "local",
    kind: "local",
    label: options.localLabel ?? "Local Core",
    baseUrl: "http://127.0.0.1:4517/",
  };
  let profiles: RemoteCoreProfile[] = [];
  let lastProfileId = "local";
  let problem: string | undefined;
  let unreadable = false;
  const listeners = new Set<(profiles: CoreProfile[]) => void>();
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid Desktop settings document");
      }
      const document = parsed as Record<string, unknown>;
      if (
        document.version !== 1 ||
        !Array.isArray(document.profiles) ||
        typeof document.lastProfileId !== "string"
      ) {
        throw new Error("Invalid Desktop settings document");
      }
      for (const value of document.profiles) {
        const profile = parseStoredRemoteProfile(value);
        const duplicate =
          profile &&
          profiles.some(
            (candidate) => candidate.id === profile.id || candidate.baseUrl === profile.baseUrl,
          );
        if (profile && !duplicate) {
          profiles.push(profile);
        } else {
          problem = `Ignored an invalid Core profile in ${path}`;
        }
      }
      const selectedId = document.lastProfileId;
      lastProfileId =
        selectedId === "local" || profiles.some((profile) => profile.id === selectedId)
          ? selectedId
          : "local";
    } catch {
      problem = `Cannot read Desktop Core profiles from ${path}`;
      unreadable = true;
    }
  }

  function save(): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify({ version: 1, profiles, lastProfileId }, null, 2)}\n`;
    try {
      (
        options.writeDocument ??
        ((target, content) => writeFileSync(target, content, { mode: 0o600 }))
      )(temporary, body);
      (options.replaceDocument ?? renameSync)(temporary, path);
    } catch (error) {
      try {
        if (existsSync(temporary)) {
          unlinkSync(temporary);
        }
      } catch {}
      throw error;
    }
  }

  function find(id: string): CoreProfile | undefined {
    return id === "local" ? local : profiles.find((profile) => profile.id === id);
  }

  function assertWritable(): void {
    if (unreadable) {
      throw new Error(`Cannot write Desktop Core profiles while ${path} is unreadable`);
    }
  }

  function notifyProfilesChanged(): void {
    for (const listener of listeners) {
      listener([{ ...local }, ...profiles.map((profile) => ({ ...profile }))]);
    }
  }

  return {
    list: () => [{ ...local }, ...profiles.map((profile) => ({ ...profile }))],
    add: (input) => {
      assertWritable();
      const profile = createRemoteCoreProfile(input, options.createId);
      if (profiles.some((candidate) => candidate.baseUrl === profile.baseUrl)) {
        throw new Error(`A Core profile already uses ${profile.baseUrl}`);
      }
      const previous = profiles;
      profiles = [...previous, profile];
      try {
        save();
      } catch (error) {
        profiles = previous;
        throw error;
      }
      notifyProfilesChanged();
      return { ...profile };
    },
    remove: (id) => {
      const profile = profiles.find((candidate) => candidate.id === id);
      if (!profile) {
        throw new Error(`Unknown remote Core profile: ${id}`);
      }
      if (lastProfileId === id) {
        throw new Error(`Select another Core before removing ${profile.label}`);
      }
      const previous = profiles;
      profiles = profiles.filter((candidate) => candidate.id !== id);
      try {
        save();
      } catch (error) {
        profiles = previous;
        throw error;
      }
      notifyProfilesChanged();
    },
    update: (id, input) => {
      const index = profiles.findIndex((profile) => profile.id === id);
      if (index === -1) {
        throw new Error(`Unknown remote Core profile: ${id}`);
      }
      const profile = createRemoteCoreProfile(input, () => id);
      if (
        profiles.some((candidate) => candidate.id !== id && candidate.baseUrl === profile.baseUrl)
      ) {
        throw new Error(`A Core profile already uses ${profile.baseUrl}`);
      }
      const previous = profiles;
      profiles = profiles.map((candidate, candidateIndex) =>
        candidateIndex === index ? profile : candidate,
      );
      try {
        save();
      } catch (error) {
        profiles = previous;
        throw error;
      }
      notifyProfilesChanged();
      return { ...profile };
    },
    select: (id) => {
      if (!find(id)) {
        throw new Error(`Unknown Core profile: ${id}`);
      }
      const previous = lastProfileId;
      lastProfileId = id;
      if (!unreadable) {
        try {
          save();
        } catch (error) {
          lastProfileId = previous;
          throw error;
        }
      }
    },
    lastSelected: () => ({ ...(find(lastProfileId) ?? local) }),
    problem: () => problem,
    canRecover: () => unreadable,
    recover: () => {
      if (!unreadable) {
        throw new Error("Desktop Core profiles do not need recovery");
      }
      const backupPath = `${path}.unreadable-${randomUUID()}`;
      renameSync(path, backupPath);
      const previousProfiles = profiles;
      const previousLastProfileId = lastProfileId;
      profiles = [];
      lastProfileId = "local";
      unreadable = false;
      try {
        save();
      } catch (error) {
        profiles = previousProfiles;
        lastProfileId = previousLastProfileId;
        unreadable = true;
        renameSync(backupPath, path);
        throw error;
      }
      problem = undefined;
      notifyProfilesChanged();
      return backupPath;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
