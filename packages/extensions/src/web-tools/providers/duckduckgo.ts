import type { WebSearchResult } from "../types.ts";
import { readLimitedResponseText } from "./response.ts";

export type DuckDuckGoSearchOptions = {
  query: string;
  maxResults: number;
  fetch?: typeof fetch;
  maxResponseBytes?: number;
  signal?: AbortSignal;
};

function unwrapResultUrl(href: string): string | undefined {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const wrapped = url.searchParams.get("uddg");
    const target = wrapped ? new URL(wrapped) : url;
    return target.protocol === "http:" || target.protocol === "https:" ? target.href : undefined;
  } catch {
    return undefined;
  }
}

export async function searchDuckDuckGo(
  options: DuckDuckGoSearchOptions,
): Promise<WebSearchResult[]> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", options.query);
  const response = await (options.fetch ?? fetch)(url, {
    headers: { "user-agent": "Cinba web_search" },
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed with HTTP ${response.status}`);
  }

  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(await readLimitedResponseText(response, options.maxResponseBytes), {
    url: response.url || url.href,
  });
  try {
    const results: WebSearchResult[] = [];
    for (const container of dom.window.document.querySelectorAll(".result")) {
      const link = container.querySelector<HTMLAnchorElement>(".result__a[href]");
      const resultUrl = link ? unwrapResultUrl(link.getAttribute("href") ?? "") : undefined;
      if (!link || !resultUrl) {
        continue;
      }
      results.push({
        title: link.textContent?.trim() ?? "",
        url: resultUrl,
        snippet: container.querySelector(".result__snippet")?.textContent?.trim() ?? "",
      });
      if (results.length >= options.maxResults) {
        break;
      }
    }
    if (results.length === 0) {
      if (dom.window.document.querySelector(".no-results")) {
        return [];
      }
      throw new Error("DuckDuckGo search returned an unrecognized HTML response");
    }
    return results;
  } finally {
    dom.window.close();
  }
}
