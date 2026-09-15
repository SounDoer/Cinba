export type WebSearchProviderId = "exa" | "brave" | "duckduckgo";
export type WebSearchPrimary = "auto" | "exa" | "brave";

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type WebSearchResponse = {
  provider: WebSearchProviderId;
  results: WebSearchResult[];
  warnings: string[];
};
