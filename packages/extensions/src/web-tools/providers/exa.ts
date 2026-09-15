import type { WebSearchResult } from "../types.ts";
import { readLimitedJsonResponse } from "./response.ts";

export type ExaSearchOptions = {
  apiKey: string;
  query: string;
  maxResults: number;
  fetch?: typeof fetch;
  maxResponseBytes?: number;
  signal?: AbortSignal;
};

export async function searchExa(options: ExaSearchOptions): Promise<WebSearchResult[]> {
  const response = await (options.fetch ?? fetch)("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": options.apiKey,
    },
    body: JSON.stringify({
      query: options.query,
      numResults: options.maxResults,
      type: "auto",
      contents: { highlights: true },
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`Exa search failed with HTTP ${response.status}`);
  }

  const payload = (await readLimitedJsonResponse(response, options.maxResponseBytes)) as {
    results?: unknown;
  };
  if (!Array.isArray(payload.results)) {
    throw new Error("Exa search returned an invalid response");
  }
  return payload.results.map((value): WebSearchResult => {
    if (typeof value !== "object" || value === null) {
      throw new Error("Exa search returned an invalid response");
    }
    const result = value as Record<string, unknown>;
    if (typeof result.title !== "string" || typeof result.url !== "string") {
      throw new Error("Exa search returned an invalid response");
    }
    const highlights = Array.isArray(result.highlights)
      ? result.highlights.filter((highlight): highlight is string => typeof highlight === "string")
      : [];
    return {
      title: result.title,
      url: result.url,
      snippet: highlights.find((highlight) => highlight.trim() !== "")?.trim() ?? "",
    };
  });
}
