import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectory } from "@cinba/test-support";
import { createStaticFileHandler } from "./static-files.ts";

async function startFixture(t: TestContext): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  const root = temporaryDirectory("cinba-static-", t);
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<h1>Cinba</h1>");
  writeFileSync(join(root, "assets", "app.js"), "console.log('ready');");

  const serveStatic = createStaticFileHandler(root);
  const server = createServer((request, response) => void serveStatic(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  assert(address && typeof address === "object");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

test("the root path serves index.html", async (t) => {
  const fixture = await startFixture(t);
  try {
    const response = await fetch(`${fixture.origin}/`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await response.text(), "<h1>Cinba</h1>");
  } finally {
    await fixture.close();
  }
});

test("an asset is served with its MIME type", async (t) => {
  const fixture = await startFixture(t);
  try {
    const response = await fetch(`${fixture.origin}/assets/app.js`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(await response.text(), "console.log('ready');");
  } finally {
    await fixture.close();
  }
});

test("a missing file explains how to build the UI", async (t) => {
  const fixture = await startFixture(t);
  try {
    const response = await fetch(`${fixture.origin}/missing.js`);

    assert.equal(response.status, 404);
    assert.equal(
      await response.text(),
      "The UI is not built yet. Run: npm run build --workspace @cinba/web",
    );
  } finally {
    await fixture.close();
  }
});
