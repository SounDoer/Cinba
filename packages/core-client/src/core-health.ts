export type CoreHealth = {
  status: "ok";
  revision: string;
  safeToRestart: boolean;
};

export type HealthResponse = {
  ok: boolean;
  json(): Promise<unknown>;
};

export type HealthFetcher = (input: string, init?: { signal?: unknown }) => Promise<HealthResponse>;

type AbortControllerShape = {
  signal: unknown;
  abort(): void;
};

type AbortControllerConstructor = new () => AbortControllerShape;

type UrlConstructor = new (input: string, base?: string) => { toString(): string };

type TimerGlobals = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

const DEFAULT_TIMEOUT_MS = 1_000;

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

function defaultFetch(input: string, init?: { signal?: unknown }): Promise<HealthResponse> {
  const fetcher = (globalThis as unknown as { fetch?: HealthFetcher }).fetch;
  if (!fetcher) {
    throw new Error("This platform does not provide fetch");
  }
  return fetcher(input, init);
}

/** Check that an HTTP endpoint is a healthy Cinba Core, not merely an open port. */
export async function probeCoreHealth(
  baseUrl: string,
  options: { fetcher?: HealthFetcher; timeoutMs?: number } = {},
): Promise<CoreHealth | undefined> {
  const controllerConstructor = (
    globalThis as unknown as { AbortController?: AbortControllerConstructor }
  ).AbortController;
  const controller = controllerConstructor ? new controllerConstructor() : undefined;
  const timers = globalThis as unknown as TimerGlobals;
  const timeout = timers.setTimeout(
    () => controller?.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const urlConstructor = (globalThis as unknown as { URL: UrlConstructor }).URL;

  try {
    const response = await (options.fetcher ?? defaultFetch)(
      new urlConstructor("/healthz", baseUrl).toString(),
      controller ? { signal: controller.signal } : undefined,
    );
    if (!response.ok) {
      return undefined;
    }
    const body = await response.json();
    return isCoreHealth(body) ? body : undefined;
  } catch {
    return undefined;
  } finally {
    timers.clearTimeout(timeout);
  }
}
