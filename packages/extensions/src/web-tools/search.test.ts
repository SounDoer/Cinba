import assert from "node:assert/strict";
import test from "node:test";
import { searchWeb } from "./search.ts";

test("a technical Exa failure falls back to Brave with a redacted warning", async () => {
  const result = await searchWeb({
    query: "Node.js 24 release notes",
    primary: "auto",
    apiKeys: { exa: "secret-exa-key", brave: "secret-brave-key" },
    adapters: {
      exa: async () => {
        throw new Error("upstream rejected secret-exa-key");
      },
      brave: async () => [
        {
          title: "Node.js 24",
          url: "https://nodejs.org/en/blog/release/v24.0.0",
          snippet: "Node.js 24 is now available.",
        },
      ],
      duckduckgo: async () => [],
    },
  });

  assert.equal(result.provider, "brave");
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.warnings, ["Exa search failed; used Brave instead."]);
  assert.equal(JSON.stringify(result).includes("secret-exa-key"), false);
});

test("a valid empty result does not call the next provider", async () => {
  let braveCalls = 0;
  const result = await searchWeb({
    query: "nothing found",
    primary: "exa",
    apiKeys: { exa: "exa-key", brave: "brave-key" },
    adapters: {
      exa: async () => [],
      brave: async () => {
        braveCalls += 1;
        return [{ title: "unexpected", url: "https://example.com", snippet: "" }];
      },
      duckduckgo: async () => [],
    },
  });

  assert.equal(result.provider, "exa");
  assert.deepEqual(result.results, []);
  assert.equal(braveCalls, 0);
});

test("a caller abort ends the search without falling back", async () => {
  const controller = new AbortController();
  const reason = new Error("user cancelled search");
  let braveCalls = 0;
  const pending = searchWeb({
    query: "cancel me",
    primary: "exa",
    apiKeys: { exa: "exa-key", brave: "brave-key" },
    signal: controller.signal,
    adapters: {
      exa: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      brave: async () => {
        braveCalls += 1;
        return [];
      },
      duckduckgo: async () => [],
    },
  });

  controller.abort(reason);

  await assert.rejects(pending, (error) => error === reason);
  assert.equal(braveCalls, 0);
});

test("a blank search query is rejected before provider routing", async () => {
  await assert.rejects(
    searchWeb({
      query: "   ",
      primary: "auto",
      apiKeys: { exa: "test-exa-key" },
      adapters: {
        exa: async () => [],
        brave: async () => [],
        duckduckgo: async () => [],
      },
    }),
    /query must not be empty/,
  );
});

test("search parameters stay within the shared provider limits", async () => {
  const adapters = {
    exa: async () => [],
    brave: async () => [],
    duckduckgo: async () => [],
  };
  const invalid = [
    { query: "x".repeat(601), maxResults: 5 },
    { query: Array.from({ length: 76 }, () => "word").join(" "), maxResults: 5 },
    { query: "valid", maxResults: 0 },
    { query: "valid", maxResults: 11 },
  ];

  for (const input of invalid) {
    await assert.rejects(
      searchWeb({
        ...input,
        primary: "auto",
        apiKeys: {},
        adapters,
      }),
      /web_search parameters exceed supported limits/,
    );
  }
});

test("a provider timeout falls back to the next configured provider", async () => {
  const result = await searchWeb({
    query: "latest Node.js release",
    primary: "auto",
    providerTimeoutMs: 10,
    apiKeys: { exa: "test-exa-key", brave: "test-brave-key" },
    adapters: {
      exa: ({ signal }) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve([]), 100);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
      brave: async () => [
        { title: "Release", url: "https://nodejs.org/", snippet: "Current release" },
      ],
      duckduckgo: async () => [],
    },
  });

  assert.equal(result.provider, "brave");
  assert.deepEqual(result.warnings, ["Exa search failed; used Brave instead."]);
});

test("one total deadline covers the whole provider fallback chain", async () => {
  await assert.rejects(
    searchWeb({
      query: "latest Node.js release",
      primary: "auto",
      providerTimeoutMs: 100,
      totalTimeoutMs: 15,
      apiKeys: { exa: "test-exa-key", brave: "test-brave-key" },
      adapters: {
        exa: ({ signal }) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("late provider failure")), 100);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(signal.reason);
              },
              { once: true },
            );
          }),
        brave: async () => [
          { title: "Release", url: "https://nodejs.org/", snippet: "Current release" },
        ],
        duckduckgo: async () => [],
      },
    }),
    /web_search timed out/,
  );
});
