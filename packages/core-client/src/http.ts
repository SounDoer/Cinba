export type HttpResponse = {
  ok: boolean;
  json(): Promise<unknown>;
};

export type HttpRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  signal?: unknown;
  body?: string;
};

export type HttpFetcher = (input: string, init?: HttpRequestInit) => Promise<HttpResponse>;

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

function defaultFetch(input: string, init?: HttpRequestInit): Promise<HttpResponse> {
  const fetcher = (globalThis as unknown as { fetch?: HttpFetcher }).fetch;
  if (!fetcher) {
    throw new Error("This platform does not provide fetch");
  }
  return fetcher(input, init);
}

export async function requestJson(
  baseUrl: string,
  path: string,
  options: {
    fetcher?: HttpFetcher;
    timeoutMs?: number;
    method?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<unknown | undefined> {
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
      new urlConstructor(path, baseUrl).toString(),
      {
        ...(options.method ? { method: options.method } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
        ...(controller ? { signal: controller.signal } : {}),
      },
    );
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  } finally {
    timers.clearTimeout(timeout);
  }
}
