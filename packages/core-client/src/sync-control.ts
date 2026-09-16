import {
  CORE_SYNC_ROUTES,
  type ConnectCoreSyncRequest,
  type CoreInstanceOverride,
  type CoreSyncOperationAccepted,
  type CoreSyncSources,
  type CoreSyncView,
  parseCoreSyncOperationAccepted,
  parseCoreSyncView,
} from "@cinba/contract";
import type { HttpFetcher } from "./http.ts";

export class CoreSyncControlError extends Error {
  readonly kind: "unavailable" | "refused" | "protocol";
  readonly status?: number;

  constructor(kind: CoreSyncControlError["kind"], message: string, status?: number) {
    super(message);
    this.name = "CoreSyncControlError";
    this.kind = kind;
    this.status = status;
  }
}

type UrlShape = { protocol: string; origin: string };
type UrlConstructor = new (input: string) => UrlShape;
type AbortControllerShape = { signal: { aborted: boolean }; abort(): void };
type AbortControllerConstructor = new () => AbortControllerShape;
type TimerGlobals = {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
};

export function coreHttpOrigin(url: string): string {
  const Url = (globalThis as unknown as { URL: UrlConstructor }).URL;
  const parsed = new Url(url);
  if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  }
  if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CoreSyncControlError("protocol", "Core URL must use HTTP or WebSocket");
  }
  return parsed.origin;
}

type ResponseShape = {
  ok: boolean;
  status?: number;
  json(): Promise<unknown>;
};

async function request<T>(options: {
  baseUrl: string;
  path: string;
  parser(value: unknown): T;
  fetcher?: HttpFetcher;
  timeoutMs: number;
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
}): Promise<T> {
  const AbortController = (globalThis as unknown as { AbortController: AbortControllerConstructor })
    .AbortController;
  const timers = globalThis as unknown as TimerGlobals;
  const controller = new AbortController();
  const timeout = timers.setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const fetcher = options.fetcher ?? (globalThis as unknown as { fetch: HttpFetcher }).fetch;
    let response: ResponseShape;
    try {
      response = await fetcher(`${options.baseUrl}${options.path}`, {
        ...(options.method ? { method: options.method } : {}),
        ...(options.body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(options.body),
            }),
        signal: controller.signal,
      } as never);
    } catch {
      throw new CoreSyncControlError(
        "unavailable",
        controller.signal.aborted ? "Core Sync request timed out" : "Core is unavailable",
      );
    }
    if (!response.ok) {
      throw new CoreSyncControlError(
        "refused",
        `Core Sync operation was refused${response.status ? ` (${response.status})` : ""}`,
        response.status,
      );
    }
    try {
      return options.parser(await response.json());
    } catch (error) {
      if (error instanceof CoreSyncControlError) {
        throw error;
      }
      throw new CoreSyncControlError("protocol", "Core returned an invalid Sync response");
    }
  } finally {
    timers.clearTimeout(timeout);
  }
}

export type CoreSyncControlClientOptions = { fetcher?: HttpFetcher; timeoutMs?: number };

export class CoreSyncControlClient {
  readonly #baseUrl: string;
  readonly #fetcher: HttpFetcher | undefined;
  readonly #timeoutMs: number;
  #syncing: Promise<CoreSyncOperationAccepted> | undefined;

  constructor(coreUrl: string, options: CoreSyncControlClientOptions = {}) {
    this.#baseUrl = coreHttpOrigin(coreUrl);
    this.#fetcher = options.fetcher;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  #request<T>(
    path: string,
    parser: (value: unknown) => T,
    method?: "GET" | "POST" | "PUT",
    body?: unknown,
  ): Promise<T> {
    return request({
      baseUrl: this.#baseUrl,
      path,
      parser,
      timeoutMs: this.#timeoutMs,
      ...(this.#fetcher ? { fetcher: this.#fetcher } : {}),
      ...(method ? { method } : {}),
      ...(body === undefined ? {} : { body }),
    });
  }

  status(): Promise<CoreSyncView> {
    return this.#request(CORE_SYNC_ROUTES.status, parseCoreSyncView);
  }

  connect(serverUrl: string, sources: CoreSyncSources): Promise<CoreSyncOperationAccepted> {
    const body: ConnectCoreSyncRequest = { version: 1, serverUrl, sources };
    return this.#request(CORE_SYNC_ROUTES.connect, parseCoreSyncOperationAccepted, "POST", body);
  }

  cancelEnrollment(): Promise<CoreSyncOperationAccepted> {
    return this.#request(CORE_SYNC_ROUTES.cancel, parseCoreSyncOperationAccepted, "POST");
  }

  disconnect(): Promise<CoreSyncOperationAccepted> {
    return this.#request(CORE_SYNC_ROUTES.disconnect, parseCoreSyncOperationAccepted, "POST");
  }

  syncNow(): Promise<CoreSyncOperationAccepted> {
    this.#syncing ??= this.#request(
      CORE_SYNC_ROUTES.syncNow,
      parseCoreSyncOperationAccepted,
      "POST",
    ).finally(() => {
      this.#syncing = undefined;
    });
    return this.#syncing;
  }

  updateSources(sources: CoreSyncSources): Promise<CoreSyncOperationAccepted> {
    return this.#request(CORE_SYNC_ROUTES.sources, parseCoreSyncOperationAccepted, "PUT", {
      version: 1,
      sources,
    });
  }

  updateOverride(override: CoreInstanceOverride): Promise<CoreSyncOperationAccepted> {
    return this.#request(CORE_SYNC_ROUTES.override, parseCoreSyncOperationAccepted, "PUT", {
      version: 1,
      override,
    });
  }
}
