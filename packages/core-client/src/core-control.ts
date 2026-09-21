import { type HttpFetcher, requestJson } from "./http.ts";
import type { CoreSyncSettings } from "@cinba/contract";

export type LocalCoreControlStatus = {
  status: "ok";
  lifetime: "persistent" | "on-demand";
  pid: number;
  clientCount: number;
  safeToStop: boolean;
  draining: boolean;
};

export type LocalCoreSyncEnrollmentReceipt = {
  enrollmentId: string;
  enrollmentSecret: string;
  expiresAt: string;
  settings: CoreSyncSettings & { version: 1 };
};

type ControlOptions = {
  fetcher?: HttpFetcher;
  timeoutMs?: number;
};

function isControlStatus(value: unknown): value is LocalCoreControlStatus {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.status === "ok" &&
    (candidate.lifetime === "on-demand" || candidate.lifetime === "persistent") &&
    Number.isInteger(candidate.pid) &&
    typeof candidate.clientCount === "number" &&
    typeof candidate.safeToStop === "boolean" &&
    typeof candidate.draining === "boolean"
  );
}

function authorization(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2_048;
}

function isSettings(value: unknown): value is CoreSyncSettings & { version: 1 } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const settings = value as Record<string, unknown>;
  const allowed = new Set(["version", "defaultModel", "webTools"]);
  if (Object.keys(settings).some((key) => !allowed.has(key)) || settings.version !== 1) {
    return false;
  }
  if (
    !settings.webTools ||
    typeof settings.webTools !== "object" ||
    Array.isArray(settings.webTools)
  ) {
    return false;
  }
  const webTools = settings.webTools as Record<string, unknown>;
  if (
    Object.keys(webTools).length !== 1 ||
    !new Set(["auto", "exa", "brave"]).has(String(webTools.searchPrimary))
  ) {
    return false;
  }
  if (settings.defaultModel !== undefined) {
    if (
      !settings.defaultModel ||
      typeof settings.defaultModel !== "object" ||
      Array.isArray(settings.defaultModel)
    ) {
      return false;
    }
    const model = settings.defaultModel as Record<string, unknown>;
    if (
      Object.keys(model).length !== 2 ||
      !boundedString(model.provider) ||
      !boundedString(model.id)
    ) {
      return false;
    }
  }
  return true;
}

function isEnrollmentReceipt(value: unknown): value is LocalCoreSyncEnrollmentReceipt & {
  status: "ok";
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const receipt = value as Record<string, unknown>;
  return (
    Object.keys(receipt).length === 5 &&
    receipt.status === "ok" &&
    boundedString(receipt.enrollmentId) &&
    boundedString(receipt.enrollmentSecret) &&
    boundedString(receipt.expiresAt) &&
    !Number.isNaN(Date.parse(receipt.expiresAt)) &&
    isSettings(receipt.settings)
  );
}

export async function requestLocalCoreStatus(
  baseUrl: string,
  token: string,
  options: ControlOptions = {},
): Promise<LocalCoreControlStatus | undefined> {
  const body = await requestJson(baseUrl, "/local-core/status", {
    ...options,
    headers: authorization(token),
  });
  return isControlStatus(body) ? body : undefined;
}

export async function requestLocalCoreStop(
  baseUrl: string,
  token: string,
  options: ControlOptions = {},
): Promise<boolean> {
  const body = await requestJson(baseUrl, "/local-core/stop", {
    ...options,
    method: "POST",
    headers: authorization(token),
  });
  return Boolean(
    body && typeof body === "object" && (body as Record<string, unknown>).status === "accepted",
  );
}

export async function requestLocalCoreLifetime(
  baseUrl: string,
  token: string,
  lifetime: "persistent" | "on-demand",
  options: ControlOptions = {},
): Promise<boolean> {
  const body = await requestJson(baseUrl, `/local-core/lifetime/${lifetime}`, {
    ...options,
    method: "POST",
    headers: authorization(token),
  });
  return Boolean(
    body &&
    typeof body === "object" &&
    (body as Record<string, unknown>).status === "accepted" &&
    (body as Record<string, unknown>).lifetime === lifetime,
  );
}

export async function requestLocalCoreSyncEnrollment(
  baseUrl: string,
  token: string,
  serverUrl: string,
  options: ControlOptions = {},
): Promise<LocalCoreSyncEnrollmentReceipt | undefined> {
  const body = await requestJson(baseUrl, "/local-core/sync-enrollment", {
    ...options,
    method: "POST",
    headers: { ...authorization(token), "content-type": "application/json" },
    body: JSON.stringify({ serverUrl }),
  });
  if (!isEnrollmentReceipt(body)) {
    return undefined;
  }
  return {
    enrollmentId: body.enrollmentId,
    enrollmentSecret: body.enrollmentSecret,
    expiresAt: body.expiresAt,
    settings: {
      version: 1,
      ...(body.settings.defaultModel ? { defaultModel: { ...body.settings.defaultModel } } : {}),
      webTools: { ...body.settings.webTools },
    },
  };
}
