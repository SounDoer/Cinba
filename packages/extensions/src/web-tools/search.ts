import { searchBrave } from "./providers/brave.ts";
import { searchDuckDuckGo } from "./providers/duckduckgo.ts";
import { searchExa } from "./providers/exa.ts";
import type {
  WebSearchPrimary,
  WebSearchProviderId,
  WebSearchResponse,
  WebSearchResult,
} from "./types.ts";

export type WebSearchAdapterRequest = {
  query: string;
  maxResults: number;
  apiKey?: string;
  signal?: AbortSignal;
};

export type WebSearchAdapters = Record<
  WebSearchProviderId,
  (request: WebSearchAdapterRequest) => Promise<WebSearchResult[]>
>;

export type SearchWebOptions = {
  query: string;
  maxResults?: number;
  primary: WebSearchPrimary;
  providerTimeoutMs?: number;
  totalTimeoutMs?: number;
  apiKeys: { exa?: string; brave?: string };
  adapters?: WebSearchAdapters;
  signal?: AbortSignal;
};

const DEFAULT_PROVIDER_TIMEOUT_MS = 8_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 20_000;

const PROVIDER_NAMES: Record<WebSearchProviderId, string> = {
  exa: "Exa",
  brave: "Brave",
  duckduckgo: "DuckDuckGo",
};

const DEFAULT_ADAPTERS: WebSearchAdapters = {
  exa: ({ apiKey, ...request }) => searchExa({ ...request, apiKey: apiKey ?? "" }),
  brave: ({ apiKey, ...request }) => searchBrave({ ...request, apiKey: apiKey ?? "" }),
  duckduckgo: (request) => searchDuckDuckGo(request),
};

export async function searchWeb(options: SearchWebOptions): Promise<WebSearchResponse> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () => timeoutController.abort(new Error("web_search timed out")),
    options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
  );
  timeout.unref();
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;
  try {
    return await searchWebWithinDeadline({ ...options, signal });
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason;
    }
    if (timeoutController.signal.aborted) {
      throw new Error("web_search timed out", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function searchWebWithinDeadline(options: SearchWebOptions): Promise<WebSearchResponse> {
  const query = options.query.trim();
  if (query === "") {
    throw new Error("web_search query must not be empty");
  }
  const maxResults = options.maxResults ?? 5;
  const wordCount = query.split(/\s+/u).length;
  if (
    query.length > 600 ||
    wordCount > 75 ||
    !Number.isInteger(maxResults) ||
    maxResults < 1 ||
    maxResults > 10
  ) {
    throw new Error("web_search parameters exceed supported limits");
  }
  const order: WebSearchProviderId[] =
    options.primary === "brave" ? ["brave", "exa", "duckduckgo"] : ["exa", "brave", "duckduckgo"];
  const adapters = options.adapters ?? DEFAULT_ADAPTERS;
  const failed: WebSearchProviderId[] = [];

  for (const provider of order) {
    const apiKey = provider === "duckduckgo" ? undefined : options.apiKeys[provider];
    if (provider !== "duckduckgo" && !apiKey) {
      continue;
    }
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(new Error(`${PROVIDER_NAMES[provider]} search timed out`)),
      options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
    );
    timeout.unref();
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;
    try {
      const results = await adapters[provider]({
        query,
        maxResults,
        apiKey,
        signal,
      });
      const warnings = failed.map(
        (failedProvider) =>
          `${PROVIDER_NAMES[failedProvider]} search failed; used ${PROVIDER_NAMES[provider]} instead.`,
      );
      return { provider, results, warnings };
    } catch {
      if (options.signal?.aborted) {
        throw options.signal.reason;
      }
      failed.push(provider);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(
    `Web search failed for: ${failed.map((provider) => PROVIDER_NAMES[provider]).join(", ")}`,
  );
}
