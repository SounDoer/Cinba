import assert from "node:assert/strict";
import test from "node:test";
import { fetchWebContent } from "./fetch-content.ts";

test("an HTML article becomes titled Markdown with absolute links", async () => {
  const html = `<!doctype html>
    <html>
      <head><title>Example Article</title></head>
      <body>
        <nav>Site navigation</nav>
        <article><h1>Hello</h1><p>Read <a href="/docs">the docs</a>.</p></article>
      </body>
    </html>`;

  const result = await fetchWebContent("https://example.com/article", {
    fetchUrl: async () => ({
      finalUrl: "https://example.com/article",
      contentType: "text/html; charset=utf-8",
      body: new TextEncoder().encode(html),
      downloadTruncated: false,
    }),
  });

  assert.equal(result.title, "Example Article");
  assert.equal(result.content, "## Hello\n\nRead [the docs](https://example.com/docs).");
  assert.equal(result.finalUrl, "https://example.com/article");
});

test("plain text bypasses HTML extraction", async () => {
  const result = await fetchWebContent("https://example.com/readme.txt", {
    fetchUrl: async () => ({
      finalUrl: "https://cdn.example.com/readme.txt",
      contentType: "text/plain; charset=utf-8",
      body: new TextEncoder().encode("plain content\nsecond line"),
      downloadTruncated: false,
    }),
  });

  assert.equal(result.title, undefined);
  assert.equal(result.content, "plain content\nsecond line");
  assert.equal(result.finalUrl, "https://cdn.example.com/readme.txt");
});

test("text is decoded with the response charset", async () => {
  const result = await fetchWebContent("https://example.com/latin.txt", {
    fetchUrl: async () => ({
      finalUrl: "https://example.com/latin.txt",
      contentType: "text/plain; charset=windows-1252",
      body: Uint8Array.from([0x63, 0x61, 0x66, 0xe9]),
      downloadTruncated: false,
    }),
  });

  assert.equal(result.content, "café");
});

test("unsupported MIME types are rejected before content extraction", async () => {
  await assert.rejects(
    fetchWebContent("https://example.com/file.pdf", {
      fetchUrl: async () => ({
        finalUrl: "https://example.com/file.pdf",
        contentType: "application/pdf",
        body: new TextEncoder().encode("not really a PDF"),
        downloadTruncated: false,
      }),
    }),
    /does not support content type: application\/pdf/,
  );
});

test("an overly complex DOM is rejected before readability analysis", async () => {
  const html = "<html><body><main><p>one</p><p>two</p></main></body></html>";

  await assert.rejects(
    fetchWebContent("https://example.com/complex", {
      fetchUrl: async () => ({
        finalUrl: "https://example.com/complex",
        contentType: "text/html",
        body: new TextEncoder().encode(html),
        downloadTruncated: false,
      }),
      maxElements: 3,
    }),
    /more than 3 elements/,
  );
});

test("a page falls back to its cleaned body when Readability finds no article", async () => {
  const result = await fetchWebContent("https://example.com/note", {
    fetchUrl: async () => ({
      finalUrl: "https://example.com/note",
      contentType: "text/html",
      body: new TextEncoder().encode("<html><body><textarea>Short note.</textarea></body></html>"),
      downloadTruncated: false,
    }),
  });

  assert.equal(result.content, "Short note.");
});
