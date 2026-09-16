import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSyncWebStaticHandler } from "./sync-web-static.ts";

test("serves the Sync SPA with safe cache behavior and never captures API routes", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "cinba-sync-web-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>Sync</title>");
  writeFileSync(join(root, "assets", "app-abc.js"), "export {};");
  const handler = createSyncWebStaticHandler(root);
  const server = createServer(async (request, response) => {
    if (!(await handler(request, response))) {
      response.writeHead(418, { "Cache-Control": "no-store" }).end("api");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  const page = await fetch(`${origin}/settings`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-cache");
  assert.match(await page.text(), /Sync/);

  const asset = await fetch(`${origin}/assets/app-abc.js`);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");

  const missingAsset = await fetch(`${origin}/assets/missing.js`);
  assert.equal(missingAsset.status, 404);

  const api = await fetch(`${origin}/api/missing`);
  assert.equal(api.status, 418);
  assert.equal(await api.text(), "api");
});
