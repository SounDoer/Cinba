import { type Parser, type SyncErrorCode, parseSyncErrorResponse } from "@cinba/sync-contract";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export type SyncHttpOptions = {
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
};

export type JsonRequest<T> = {
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
  parser: Parser<T>;
  sensitive?: boolean;
  allowNotModified?: boolean;
};

export type JsonResponse<T> =
  { status: "ok"; value: T; etag?: string } | { status: "not-modified"; etag?: string };

export class SyncClientError extends Error {
  readonly kind: "transport" | "protocol" | "http";
  readonly status?: number;
  readonly code?: SyncErrorCode;
  readonly retryable: boolean;

  constructor(options: {
    kind: "transport" | "protocol" | "http";
    message: string;
    status?: number;
    code?: SyncErrorCode;
    retryable?: boolean;
  }) {
    super(options.message);
    this.name = "SyncClientError";
    this.kind = options.kind;
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
  }
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]" ||
    normalized.endsWith(".localhost")
  );
}

export function normalizeSyncServerUrl(
  input: string,
  options: { allowInsecureLoopback?: boolean } = {},
): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SyncClientError({
      kind: "protocol",
      message: "Sync Server URL is invalid",
    });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new SyncClientError({
      kind: "protocol",
      message: "Sync Server URL must not contain credentials, query, or fragment",
    });
  }
  if (url.pathname !== "/") {
    throw new SyncClientError({
      kind: "protocol",
      message: "Sync Server URL must be an origin without a path",
    });
  }
  if (url.protocol !== "https:") {
    if (url.protocol !== "http:" || !options.allowInsecureLoopback || !isLoopback(url.hostname)) {
      throw new SyncClientError({
        kind: "protocol",
        message: "Sync Server URL must use HTTPS",
      });
    }
  }
  return url.origin;
}

function hasNoStore(headers: Headers): boolean {
  return (headers.get("cache-control") ?? "")
    .toLowerCase()
    .split(",")
    .some((part) => part.trim() === "no-store");
}

async function readBoundedBody(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) {
    throw new SyncClientError({
      kind: "protocol",
      message: "Sync response exceeds the configured size limit",
    });
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new SyncClientError({
        kind: "protocol",
        message: "Sync response exceeds the configured size limit",
      });
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function requireJson(response: Response): void {
  const mediaType = (response.headers.get("content-type") ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw new SyncClientError({
      kind: "protocol",
      message: "Sync response is not JSON",
    });
  }
}

export class SyncHttpClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(
    baseUrl: string,
    options: SyncHttpOptions & { allowInsecureLoopback?: boolean } = {},
  ) {
    this.baseUrl = normalizeSyncServerUrl(baseUrl, options);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.fetchImplementation = options.fetch ?? fetch;
  }

  async json<T>(request: JsonRequest<T>): Promise<JsonResponse<T>> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;
    const headers = new Headers(request.headers);
    headers.set("Accept", "application/json");
    if (request.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}${request.path}`, {
        method: request.method ?? "GET",
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal,
        credentials: "include",
      });
    } catch {
      let message = "Sync Server is unreachable";
      if (timeout.aborted) {
        message = "Sync request timed out";
      } else if (request.signal?.aborted) {
        message = "Sync request was aborted";
      }
      throw new SyncClientError({ kind: "transport", message, retryable: true });
    }

    if (request.sensitive && !hasNoStore(response.headers)) {
      throw new SyncClientError({
        kind: "protocol",
        message: "Sensitive Sync response is missing Cache-Control: no-store",
      });
    }
    const etag = response.headers.get("etag") ?? undefined;
    if (response.status === 304 && request.allowNotModified) {
      return { status: "not-modified", ...(etag ? { etag } : {}) };
    }

    requireJson(response);
    const body = await readBoundedBody(response, this.maxResponseBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      throw new SyncClientError({
        kind: "protocol",
        message: "Sync response contains invalid JSON",
      });
    }

    if (!response.ok) {
      try {
        const error = parseSyncErrorResponse(parsed).error;
        throw new SyncClientError({
          kind: "http",
          message: `Sync request failed (${response.status}, ${error.code})`,
          status: response.status,
          code: error.code,
          retryable: error.retryable,
        });
      } catch (error) {
        if (error instanceof SyncClientError) {
          throw error;
        }
        throw new SyncClientError({
          kind: "http",
          message: `Sync request failed (${response.status})`,
          status: response.status,
        });
      }
    }

    try {
      const value = request.parser(parsed);
      return { status: "ok", value, ...(etag ? { etag } : {}) };
    } catch {
      throw new SyncClientError({
        kind: "protocol",
        message: "Sync response does not match the expected schema",
      });
    }
  }
}

export function valueFrom<T>(response: JsonResponse<T>): T {
  if (response.status !== "ok") {
    throw new SyncClientError({
      kind: "protocol",
      message: "Sync Server returned Not Modified where a body was required",
    });
  }
  return response.value;
}
