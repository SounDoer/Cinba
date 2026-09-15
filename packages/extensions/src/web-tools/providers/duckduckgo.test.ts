import assert from "node:assert/strict";
import test from "node:test";
import { searchDuckDuckGo } from "./duckduckgo.ts";

test("DuckDuckGo HTML search unwraps result URLs and normalizes snippets", async () => {
  const results = await searchDuckDuckGo({
    query: "Node.js 24 release notes",
    maxResults: 5,
    fetch: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.origin + url.pathname, "https://html.duckduckgo.com/html/");
      assert.equal(url.searchParams.get("q"), "Node.js 24 release notes");
      return new Response(
        `<html><body>
          <div class="result">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fblog%2Frelease%2Fv24.0.0">Node.js 24</a>
            <a class="result__snippet">Node.js 24 is now available.</a>
          </div>
        </body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
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

test("DuckDuckGo returns an empty result only for a recognized no-results page", async () => {
  const results = await searchDuckDuckGo({
    query: "query with no matches",
    maxResults: 5,
    fetch: async () =>
      new Response('<html><body><div class="no-results">No results.</div></body></html>', {
        status: 200,
      }),
  });

  assert.deepEqual(results, []);
});
