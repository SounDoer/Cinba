import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSyncProfileStore } from "./sync-profile-store.ts";
import { createCoreProfileStore } from "./profile-store.ts";

test("the single Sync profile persists separately without credentials or session state", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "cinba-desktop-sync-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "sync.json");
  const store = createSyncProfileStore(path);
  store.set("https://sync.example.test/");
  assert.deepEqual(createSyncProfileStore(path).get(), {
    id: "sync",
    kind: "sync",
    label: "Cinba Sync",
    baseUrl: "https://sync.example.test/",
  });
  const body = readFileSync(path, "utf8");
  assert.doesNotMatch(body, /password|cookie|session|credential/i);
  store.clear();
  assert.equal(store.get(), undefined);
});

test("Sync profiles require an HTTPS origin and are not Core profiles", () => {
  const invalid = ["http://sync.test/", "https://sync.test/path", "javascript:alert(1)"];
  for (const url of invalid) {
    assert.throws(() => createSyncProfileStore("missing").set(url));
  }
});

test("Core profiles and the global Sync service use separate stores and types", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "cinba-desktop-services-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const cores = createCoreProfileStore(join(directory, "desktop.json"));
  const sync = createSyncProfileStore(join(directory, "desktop-sync.json"));
  cores.add({ label: "VPS Core", baseUrl: "https://core.example.test/" });
  sync.set("https://sync.example.test/");
  assert.equal(
    cores.list().some((profile) => profile.baseUrl.includes("sync.example")),
    false,
  );
  assert.equal(sync.get()?.kind, "sync");
});
