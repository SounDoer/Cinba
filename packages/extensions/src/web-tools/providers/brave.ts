import type { WebSearchResult } from "../types.ts";

export type BraveSearchOptions = {
  apiKey: string;
  query: string;
  maxResults: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
};

export async function searchBrave(options: BraveSearchOptions): Promise<WebSearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", options.query);
  url.searchParams.set("count", String(options.maxResults));
  const response = await (options.fetch ?? fetch)(url, {
    headers: {
      accept: "application/json",
      "api-version": "2023-01-01",
      "x-subscription-token": options.apiKey,
    },
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`Brave search failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { web?: { results?: unknown } };
  if (!Array.isArray(payload.web?.results)) {
    throw new Error("Brave search returned an invalid response");
  }
  return payload.web.results.flatMap((value): WebSearchResult[] => {
    if (typeof value !== "object" || value === null) {
      return [];
    }
    const result = value as Record<string, unknown>;
    if (typeof result.title !== "string" || typeof result.url !== "string") {
      return [];
    }
    return [
      {
        title: result.title,
        url: result.url,
        snippet: typeof result.description === "string" ? result.description.trim() : "",
      },
    ];
  });
}
