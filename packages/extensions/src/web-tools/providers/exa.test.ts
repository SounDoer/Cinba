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
