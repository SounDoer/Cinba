import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type LocalCoreControlStatus, requestLocalCoreStatus } from "@cinba/core-client";
import type { ManagedSyncControlConfig } from "./sync-control.ts";

export type CoreServiceStatusRequest = (
  baseUrl: string,
  token: string,
) => Promise<LocalCoreControlStatus | undefined>;

/** The Background Core records its PID and control token in the same format as managed Sync. */
export function createCoreServiceControlConfig(stateDirectory: string): ManagedSyncControlConfig {
  if (!isAbsolute(stateDirectory)) {
    throw new Error("Core service control state directory must be absolute");
  }
  return {
    baseUrl: "http://127.0.0.1:4517/",
    runtimePath: join(stateDirectory, "core-service-runtime.json"),
    controlPath: join(stateDirectory, "core-service-control.json"),
  };
}

async function readControl(path: string): Promise<{ pid: number; token: string } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    return parsed.schemaVersion === 1 &&
      Number.isSafeInteger(parsed.pid) &&
      (parsed.pid as number) > 0 &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0
      ? { pid: parsed.pid as number, token: parsed.token }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Prove that the Core answering on the local port is the Background service itself, not an
 * on-demand or foreign Core that happens to hold the address.
 */
export async function verifyCoreServiceIdentity(
  config: ManagedSyncControlConfig,
  requestStatus: CoreServiceStatusRequest = requestLocalCoreStatus,
): Promise<void> {
  const control = await readControl(config.controlPath);
  if (!control) {
    throw new Error("Cinba Core Background service has not recorded its identity");
  }
  const status = await requestStatus(config.baseUrl, control.token);
  if (status?.pid !== control.pid) {
    throw new Error("the Core answering on 127.0.0.1:4517 is not the Background service");
  }
}
