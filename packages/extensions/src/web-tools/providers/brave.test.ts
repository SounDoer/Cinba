import assert from "node:assert/strict";
import test from "node:test";
import { searchBrave } from "./brave.ts";

test("Brave Web Search sends its versioned request and normalizes results", async () => {
  const results = await searchBrave({
    apiKey: "test-brave-key",
    query: "Node.js 24 release notes",
    maxResults: 4,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin + url.pathname, "https://api.search.brave.com/res/v1/web/search");
      assert.equal(url.searchParams.get("q"), "Node.js 24 release notes");
      assert.equal(url.searchParams.get("count"), "4");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-subscription-token"), "test-brave-key");
      assert.equal(headers.get("api-version"), "2023-01-01");
      return new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: "Node.js 24",
                url: "https://nodejs.org/en/blog/release/v24.0.0",
                description: "Node.js 24 is now available.",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.deepEqual(results, [
    {
      title: "Node.js 24",
      url: "https://nodejs.org/en/blog/release/v24.0.0",
      snippet: "Node.js 24 is now available.",
    },
  ]);
});
