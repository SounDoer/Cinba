import assert from "node:assert/strict";
import test from "node:test";
import { searchExa } from "./exa.ts";

test("Exa search requests highlights and normalizes results", async () => {
  const results = await searchExa({
    apiKey: "test-exa-key",
    query: "Node.js 24 release notes",
    maxResults: 3,
    fetch: async (input, init) => {
      assert.equal(input, "https://api.exa.ai/search");
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("x-api-key"), "test-exa-key");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        query: "Node.js 24 release notes",
        numResults: 3,
        type: "auto",
        contents: { highlights: true },
      });
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Node.js 24",
              url: "https://nodejs.org/en/blog/release/v24.0.0",
              highlights: ["Node.js 24 is now available."],
            },
          ],
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

test("Exa rejects a response larger than the provider body limit", async () => {
  await assert.rejects(
    searchExa({
      apiKey: "test-exa-key",
      query: "large response",
      maxResults: 1,
      maxResponseBytes: 10,
      fetch: async () => new Response(JSON.stringify({ results: [] })),
    }),
    /response exceeds 10 bytes/,
  );
});

test("Exa does not disguise malformed result entries as an empty search", async () => {
  await assert.rejects(
    searchExa({
      apiKey: "test-exa-key",
      query: "malformed",
      maxResults: 1,
      fetch: async () => new Response(JSON.stringify({ results: [{ title: "missing URL" }] })),
    }),
    /invalid response/,
  );
});
