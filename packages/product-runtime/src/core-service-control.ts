import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  type LocalCoreControlStatus,
  type LocalCoreSyncEnrollmentReceipt,
  requestLocalCoreStatus,
  requestLocalCoreSyncEnrollment,
  requestLocalCoreSyncHostDeletePreparation,
} from "@cinba/core-client";
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
    return Number.isSafeInteger(parsed.pid) &&
      (parsed.pid as number) > 0 &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0
      ? { pid: parsed.pid as number, token: parsed.token }
      : undefined;
  } catch {
    return undefined;
  }
}

export async function beginManagedCoreSyncEnrollment(
  config: ManagedSyncControlConfig,
  serverUrl: string,
  options: {
    requestStatus?: CoreServiceStatusRequest;
    requestEnrollment?: (
      baseUrl: string,
      token: string,
      serverUrl: string,
    ) => Promise<LocalCoreSyncEnrollmentReceipt | undefined>;
  } = {},
): Promise<LocalCoreSyncEnrollmentReceipt> {
  const control = await readControl(config.controlPath);
  if (!control) {
    throw new Error("Cinba Core has not recorded its manager identity");
  }
  const status = await (options.requestStatus ?? requestLocalCoreStatus)(
    config.baseUrl,
    control.token,
  );
  if (status?.pid !== control.pid) {
    throw new Error("the Core answering on 127.0.0.1:4517 is not owned by this manager");
  }
  const receipt = await (options.requestEnrollment ?? requestLocalCoreSyncEnrollment)(
    config.baseUrl,
    control.token,
    serverUrl,
  );
  if (!receipt) {
    throw new Error("Cinba Core refused the local Sync enrollment request");
  }
  return receipt;
}

export async function prepareManagedCoreSyncHostDelete(
  config: ManagedSyncControlConfig,
  options: {
    requestStatus?: CoreServiceStatusRequest;
    requestPreparation?: (baseUrl: string, token: string) => Promise<boolean>;
  } = {},
): Promise<void> {
  const control = await readControl(config.controlPath);
  if (!control) {
    throw new Error("Cinba Core has not recorded its manager identity");
  }
  const status = await (options.requestStatus ?? requestLocalCoreStatus)(
    config.baseUrl,
    control.token,
  );
  if (status?.pid !== control.pid) {
    throw new Error("the Core answering on 127.0.0.1:4517 is not owned by this manager");
  }
  const accepted = await (options.requestPreparation ?? requestLocalCoreSyncHostDeletePreparation)(
    config.baseUrl,
    control.token,
  );
  if (!accepted) {
    throw new Error(
      "Cinba Core could not preserve its Sync settings before Host deletion; move Shared Credentials to Local first",
    );
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
