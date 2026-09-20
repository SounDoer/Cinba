import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import { createCoreProfileStore } from "./profile-store.ts";

test("a remote Core profile survives restarting the Desktop store", (t) => {
  const directory = temporaryDirectory("cinba-desktop-profiles-", t);
  const path = join(directory, "desktop.json");
  const store = createCoreProfileStore(path, {
    createId: () => "profile-1",
    localLabel: "This PC",
  });
  store.add({ label: "VPS", baseUrl: "https://cinba-vps.example.ts.net" });

  assert.deepEqual(createCoreProfileStore(path, { localLabel: "This PC" }).list(), [
    {
      id: "local",
      kind: "local",
      label: "This PC",
      baseUrl: "http://127.0.0.1:4517/",
    },
    {
      id: "profile-1",
      kind: "remote",
      label: "VPS",
      baseUrl: "https://cinba-vps.example.ts.net/",
    },
  ]);
});

test("the Desktop reopens the last selected Core profile", (t) => {
  const directory = temporaryDirectory("cinba-desktop-profiles-", t);
  const path = join(directory, "desktop.json");
  const store = createCoreProfileStore(path, {
    createId: () => "profile-1",
    localLabel: "This PC",
  });
  store.add({ label: "VPS", baseUrl: "https://cinba-vps.example.ts.net" });
  store.select("profile-1");

  assert.equal(
    createCoreProfileStore(path, { localLabel: "This PC" }).lastSelected().id,
    "profile-1",
  );
});

test("the Desktop refuses duplicate Core origins", (t) => {
  const directory = temporaryDirectory("cinba-desktop-profiles-", t);
  const path = join(directory, "desktop.json");
  const store = createCoreProfileStore(path, { localLabel: "This PC" });
  store.add({ label: "VPS", baseUrl: "https://cinba-vps.example.ts.net" });

  assert.throws(
    () => store.add({ label: "Duplicate", baseUrl: "https://cinba-vps.example.ts.net:443/" }),
    { message: "A Core profile already uses https://cinba-vps.example.ts.net/" },
  );
});

test("a user can edit a saved remote Core profile", (t) => {
  const directory = temporaryDirectory("cinba-desktop-profiles-", t);
  const path = join(directory, "desktop.json");
  const store = createCoreProfileStore(path, { createId: () => "profile-1" });
  store.add({ label: "Old", baseUrl: "https://old.test" });
  store.update("profile-1", { label: "Home Mac", baseUrl: "https://cinba-mac.test" });

  assert.deepEqual(createCoreProfileStore(path).list()[1], {
    id: "profile-1",
    kind: "remote",
    label: "Home Mac",
    baseUrl: "https://cinba-mac.test/",
  });
});

test("a user can remove a remote Core that is not selected", (t) => {
  const directory = temporaryDirectory("cinba-desktop-profiles-", t);
  const path = join(directory, "desktop.json");
  const store = createCoreProfileStore(path, { createId: () => "profile-1" });
  store.add({ label: "VPS", baseUrl: "https://cinba-vps.test" });
  store.remove("profile-1");

  assert.deepEqual(
    createCoreProfileStore(path)
      .list()
      .map((profile) => profile.id),
    ["local"],
  );
});

test("the selected Core profile cannot be removed", (t) => {
  const directory = temporaryDirectory("cinba-desktop-profiles-", t);
  const path = join(directory, "desktop.json");
  const store = createCoreProfileStore(path, { createId: () => "profile-1" });
  store.add({ label: "VPS", baseUrl: "https://cinba-vps.test" });
  store.select("profile-1");

  assert.throws(() => store.remove("profile-1"), {
    message: "Select another Core before removing VPS",
  });
});

test("a damaged Desktop profile file leaves the Local Core available", (t) => {
  const directory = temporaryDirectory("cinba-desktop-profiles-", t);
  const path = join(directory, "desktop.json");
  writeFileSync(path, "{broken", "utf8");

  const store = createCoreProfileStore(path, { localLabel: "This PC" });

  assert.deepEqual(
    { ids: store.list().map((profile) => profile.id), problem: store.problem() },
    { ids: ["local"], problem: `Cannot read Desktop Core profiles from ${path}` },
  );
});

test("a damaged Desktop profile file is not overwritten by a normal edit", (t) => {
  const directory = temporaryDirectory("cinba-desktop-profiles-", t);
  const path = join(directory, "desktop.json");
  writeFileSync(path, "{broken", "utf8");
  const store = createCoreProfileStore(path);

  assert.throws(() => store.add({ label: "VPS", baseUrl: "https://cinba-vps.test" }), {
    message: `Cannot write Desktop Core profiles while ${path} is unreadable`,
  });
});

test("opening the Local Core cannot overwrite a damaged profile file", (t) => {
  const directory = temporaryDirectory("cinba-desktop-profiles-", t);
  const path = join(directory, "desktop.json");
  writeFileSync(path, "{broken", "utf8");
  const store = createCoreProfileStore(path);
  store.select("local");

  assert.equal(readFileSync(path, "utf8"), "{broken");
});

test("one invalid remote Core does not hide the rest of the profile list", (t) => {
  const directory = temporaryDirectory("cinba-desktop-profiles-", t);
  const path = join(directory, "desktop.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      profiles: [
        { id: "unsafe", kind: "remote", label: "Unsafe", baseUrl: "http://unsafe.test/" },
        {
          id: "vps",
          kind: "remote",
          label: "VPS",
          baseUrl: "https://cinba-vps.test/",
        },
      ],
      lastProfileId: "local",
    }),
    "utf8",
  );

  const store = createCoreProfileStore(path, { localLabel: "This PC" });

  assert.deepEqual(
    { ids: store.list().map((profile) => profile.id), problem: store.problem() },
    { ids: ["local", "vps"], problem: `Ignored an invalid Core profile in ${path}` },
  );
});

test("an invalid Desktop settings document is preserved as unreadable", (t) => {
  const directory = temporaryDirectory("cinba-desktop-profiles-", t);
  const path = join(directory, "desktop.json");
  const body = JSON.stringify({ version: 2, profiles: [], lastProfileId: "local" });
  writeFileSync(path, body, "utf8");

  const store = createCoreProfileStore(path);

  assert.equal(store.problem(), `Cannot read Desktop Core profiles from ${path}`);
  assert.throws(() => store.add({ label: "VPS", baseUrl: "https://cinba-vps.test" }));
  assert.equal(readFileSync(path, "utf8"), body);
});

test("an unreadable Desktop settings file can be recovered without losing its original", (t) => {
  const directory = temporaryDirectory("cinba-desktop-profiles-", t);
  const path = join(directory, "desktop.json");
  writeFileSync(path, "{broken", "utf8");
  const store = createCoreProfileStore(path, { createId: () => "vps" });

  const backupPath = store.recover();
  store.add({ label: "VPS", baseUrl: "https://cinba-vps.test" });

  assert.equal(readFileSync(backupPath, "utf8"), "{broken");
  assert.equal(store.problem(), undefined);
  assert.equal(store.canRecover(), false);
  assert.deepEqual(
    createCoreProfileStore(path)
      .list()
      .map((profile) => profile.id),
    ["local", "vps"],
  );
});

test("a missing last-selected profile falls back to Local", (t) => {
  const directory = temporaryDirectory("cinba-desktop-profiles-", t);
  const path = join(directory, "desktop.json");
  writeFileSync(
    path,
    JSON.stringify({ version: 1, profiles: [], lastProfileId: "missing" }),
    "utf8",
  );

  assert.equal(createCoreProfileStore(path).lastSelected().id, "local");
});

test("Desktop surfaces refresh after a profile is saved", (t) => {
  const directory = temporaryDirectory("cinba-desktop-profiles-", t);
  const path = join(directory, "desktop.json");
  const store = createCoreProfileStore(path, { createId: () => "vps" });
  let visibleIds: string[] = [];
  store.subscribe((profiles) => {
    visibleIds = profiles.map((profile) => profile.id);
  });

  store.add({ label: "VPS", baseUrl: "https://cinba-vps.test" });

  assert.deepEqual(visibleIds, ["local", "vps"]);
});

test("editing a Core cannot duplicate another saved origin", (t) => {
  const directory = temporaryDirectory("cinba-desktop-profiles-", t);
  const path = join(directory, "desktop.json");
  let nextId = 0;
  const store = createCoreProfileStore(path, {
    createId: () => {
      nextId += 1;
      return `profile-${nextId}`;
    },
  });
  store.add({ label: "VPS", baseUrl: "https://cinba-vps.test" });
  store.add({ label: "Mac", baseUrl: "https://cinba-mac.test" });

  assert.throws(
    () => store.update("profile-2", { label: "Mac", baseUrl: "https://cinba-vps.test" }),
    { message: "A Core profile already uses https://cinba-vps.test/" },
  );
});

test("a failed profile save leaves the last complete file readable", (t) => {
  const directory = temporaryDirectory("cinba-desktop-profiles-", t);
  const path = join(directory, "desktop.json");
  createCoreProfileStore(path, { createId: () => "vps" }).add({
    label: "VPS",
    baseUrl: "https://cinba-vps.test",
  });
  const failing = createCoreProfileStore(path, {
    createId: () => "mac",
    writeDocument: (target) => {
      writeFileSync(target, "{partial", "utf8");
      throw new Error("disk full");
    },
  });
  let message = "";
  try {
    failing.add({ label: "Mac", baseUrl: "https://cinba-mac.test" });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert.deepEqual(
    {
      message,
      liveIds: failing.list().map((profile) => profile.id),
      ids: createCoreProfileStore(path)
        .list()
        .map((profile) => profile.id),
    },
    { message: "disk full", liveIds: ["local", "vps"], ids: ["local", "vps"] },
  );
});

test("failed updates, removals, and selections roll back live profile state", (t) => {
  const directory = temporaryDirectory("cinba-desktop-profiles-", t);
  const path = join(directory, "desktop.json");
  createCoreProfileStore(path, { createId: () => "vps" }).add({
    label: "VPS",
    baseUrl: "https://cinba-vps.test",
  });
  const failing = createCoreProfileStore(path, {
    replaceDocument: () => {
      throw new Error("disk full");
    },
  });

  assert.throws(
    () => failing.update("vps", { label: "Changed", baseUrl: "https://changed.test" }),
    { message: "disk full" },
  );
  assert.equal(failing.list()[1]?.label, "VPS");
  assert.throws(() => failing.remove("vps"), { message: "disk full" });
  assert.deepEqual(
    failing.list().map((profile) => profile.id),
    ["local", "vps"],
  );
  assert.throws(() => failing.select("vps"), { message: "disk full" });
  assert.equal(failing.lastSelected().id, "local");
});

test("Desktop surfaces refresh after profiles are edited or removed", (t) => {
  const directory = temporaryDirectory("cinba-desktop-profiles-", t);
  const path = join(directory, "desktop.json");
  const store = createCoreProfileStore(path, { createId: () => "vps" });
  const snapshots: string[][] = [];
  store.subscribe((profiles) => {
    snapshots.push(profiles.map((profile) => profile.label));
  });

  store.add({ label: "VPS", baseUrl: "https://cinba-vps.test" });
  store.update("vps", { label: "Remote", baseUrl: "https://cinba-vps.test" });
  store.remove("vps");

  assert.deepEqual(snapshots, [["Local Core", "VPS"], ["Local Core", "Remote"], ["Local Core"]]);
});
