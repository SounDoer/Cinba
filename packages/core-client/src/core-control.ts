import { type HttpFetcher, requestJson } from "./http.ts";

export type LocalCoreControlStatus = {
  status: "ok";
  lifetime: "on-demand";
  pid: number;
  clientCount: number;
  safeToStop: boolean;
  draining: boolean;
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
    candidate.lifetime === "on-demand" &&
    Number.isInteger(candidate.pid) &&
    typeof candidate.clientCount === "number" &&
    typeof candidate.safeToStop === "boolean" &&
    typeof candidate.draining === "boolean"
  );
}

function authorization(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
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
