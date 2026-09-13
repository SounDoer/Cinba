export type CoreHealth = {
  status: "ok";
  revision: string;
  safeToRestart: boolean;
};

import { requestJson, type HttpFetcher, type HttpResponse } from "./http.ts";

export type HealthResponse = HttpResponse;
export type HealthFetcher = HttpFetcher;

function isCoreHealth(value: unknown): value is CoreHealth {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.status === "ok" &&
    typeof candidate.revision === "string" &&
    typeof candidate.safeToRestart === "boolean"
  );
}

/** Check that an HTTP endpoint is a healthy Cinba Core, not merely an open port. */
export async function probeCoreHealth(
  baseUrl: string,
  options: { fetcher?: HealthFetcher; timeoutMs?: number } = {},
): Promise<CoreHealth | undefined> {
  const body = await requestJson(baseUrl, "/healthz", options);
  return isCoreHealth(body) ? body : undefined;
}
