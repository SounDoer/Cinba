import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { ProductPaths } from "@cinba/installer";

export const LOCAL_SYNC_ORIGIN = "http://127.0.0.1:4518";

export type SyncHostConfig = {
  schemaVersion: 1;
  publicOrigin: string;
};

export type SyncHostStorageState =
  | { state: "not-created" }
  | { state: "created"; config: SyncHostConfig }
  | { state: "missing-authority"; config: SyncHostConfig }
  | { state: "orphaned-authority" }
  | { state: "invalid-config"; error: SyncHostConfigError };

export class SyncHostConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SyncHostConfigError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SyncHostConfigError("Sync Host config must be an object");
  }
  return value as Record<string, unknown>;
}

function canonicalPublicOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new SyncHostConfigError("Sync Host publicOrigin must be a non-empty string");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new SyncHostConfigError("Sync Host publicOrigin must be an absolute URL", { cause });
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new SyncHostConfigError(
      "Sync Host publicOrigin must not contain credentials, a path, query, or fragment",
    );
  }
  if (url.protocol === "http:") {
    if (url.origin !== LOCAL_SYNC_ORIGIN) {
      throw new SyncHostConfigError(
        `HTTP is allowed only for the local Sync origin ${LOCAL_SYNC_ORIGIN}`,
      );
    }
  } else if (url.protocol !== "https:") {
    throw new SyncHostConfigError("Remote Sync Host publicOrigin must use HTTPS");
  }
  return url.origin;
}

export function createSyncHostConfig(publicOrigin = LOCAL_SYNC_ORIGIN): SyncHostConfig {
  return { schemaVersion: 1, publicOrigin: canonicalPublicOrigin(publicOrigin.trim()) };
}

export function parseSyncHostConfig(value: unknown): SyncHostConfig {
  const parsed = record(value);
  if (
    Object.keys(parsed).length !== 2 ||
    !("schemaVersion" in parsed) ||
    !("publicOrigin" in parsed)
  ) {
    throw new SyncHostConfigError("Sync Host config has unexpected or missing fields");
  }
  if (parsed.schemaVersion !== 1) {
    throw new SyncHostConfigError("Sync Host config schemaVersion must be 1");
  }
  const publicOrigin = canonicalPublicOrigin(parsed.publicOrigin);
  if (publicOrigin !== parsed.publicOrigin) {
    throw new SyncHostConfigError("Sync Host publicOrigin must use its canonical origin form");
  }
  return { schemaVersion: 1, publicOrigin };
}

export function syncHostConfigPath(paths: Pick<ProductPaths, "configurationDirectory">): string {
  if (!isAbsolute(paths.configurationDirectory)) {
    throw new SyncHostConfigError("Sync Host configuration directory must be absolute");
  }
  return join(paths.configurationDirectory, "sync.json");
}

export async function readSyncHostConfig(path: string): Promise<SyncHostConfig | undefined> {
  try {
    return parseSyncHostConfig(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    if (error instanceof SyncHostConfigError) {
      throw error;
    }
    throw new SyncHostConfigError("Sync Host config is not valid JSON", { cause: error });
  }
}

export async function writeSyncHostConfig(path: string, config: SyncHostConfig): Promise<void> {
  const parsed = parseSyncHostConfig(config);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function inspectSyncHostStorage(
  paths: Pick<ProductPaths, "configurationDirectory" | "syncDataDirectory">,
): Promise<SyncHostStorageState> {
  const configPath = syncHostConfigPath(paths);
  const authorityExists = await exists(paths.syncDataDirectory);
  let config: SyncHostConfig | undefined;
  try {
    config = await readSyncHostConfig(configPath);
  } catch (error) {
    return {
      state: "invalid-config",
      error:
        error instanceof SyncHostConfigError
          ? error
          : new SyncHostConfigError("Sync Host config could not be read", { cause: error }),
    };
  }
  if (!config) {
    return authorityExists ? { state: "orphaned-authority" } : { state: "not-created" };
  }
  return authorityExists ? { state: "created", config } : { state: "missing-authority", config };
}
