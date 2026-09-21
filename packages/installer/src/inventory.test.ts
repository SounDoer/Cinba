import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import {
  type ArtifactInventory,
  createArtifactInventory,
  parseArtifactInventory,
  verifyArtifactInventory,
} from "./inventory.ts";

const REVISION = "0123456789abcdef0123456789abcdef01234567";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function inventory(files: ArtifactInventory["files"]): unknown {
  return {
    schemaVersion: 1,
    product: "Cinba",
    version: "0.1.0",
    revision: REVISION,
    target: "windows-x64",
    files,
  };
}

test("parses a deterministic artifact inventory", () => {
  const value = inventory([
    { path: "bin/cinba.exe", size: 5, sha256: digest("cinba"), executable: false },
    { path: "runtime/node.exe", size: 4, sha256: digest("node"), executable: false },
  ]);
  assert.deepEqual(parseArtifactInventory(value), value);
});

test("rejects unsafe, duplicate, and unsorted inventory paths", () => {
  for (const path of ["../secret", "/absolute", "bin\\cinba", "bin//cinba", "bin/./cinba"]) {
    assert.throws(
      () =>
        parseArtifactInventory(
          inventory([{ path, size: 1, sha256: digest("x"), executable: false }]),
        ),
      /normalized relative POSIX path/,
    );
  }

  assert.throws(
    () =>
      parseArtifactInventory(
        inventory([
          { path: "z", size: 1, sha256: digest("z"), executable: false },
          { path: "a", size: 1, sha256: digest("a"), executable: false },
        ]),
      ),
    /unique and sorted/,
  );
});

test("verifies every payload file while exempting the inventory itself", async (t) => {
  const root = temporaryDirectory("cinba-inventory-", t);
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "cinba.exe"), "cinba");
  writeFileSync(join(root, "inventory.json"), "generated separately");
  const parsed = parseArtifactInventory(
    inventory([{ path: "bin/cinba.exe", size: 5, sha256: digest("cinba"), executable: false }]),
  );

  assert.deepEqual(await verifyArtifactInventory(root, parsed), { valid: true, problems: [] });
});

test("generates a sorted inventory without hashing the inventory file itself", async (t) => {
  const root = temporaryDirectory("cinba-inventory-", t);
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "z.txt"), "z");
  await writeFile(join(root, "bin", "cinba.exe"), "cinba");
  await writeFile(join(root, "inventory.json"), "old inventory");

  const generated = await createArtifactInventory(root, {
    version: "0.1.0",
    revision: REVISION,
    target: "windows-x64",
  });
  assert.deepEqual(
    generated.files.map((file) => file.path),
    ["bin/cinba.exe", "z.txt"],
  );
  assert.deepEqual(await verifyArtifactInventory(root, generated), {
    valid: true,
    problems: [],
  });
});

test(
  "records and verifies safe relative symlinks without following them",
  { skip: process.platform === "win32" && "release symlinks exist only in macOS artifacts" },
  async (t) => {
    const root = temporaryDirectory("cinba-inventory-links-", t);
    await mkdir(join(root, "Framework.framework", "Versions", "A"), { recursive: true });
    await writeFile(join(root, "Framework.framework", "Versions", "A", "Framework"), "binary");
    await symlink("A", join(root, "Framework.framework", "Versions", "Current"));
    await symlink("Versions/Current/Framework", join(root, "Framework.framework", "Framework"));

    const generated = await createArtifactInventory(root, {
      version: "0.1.0",
      revision: REVISION,
      target: "macos-arm64",
    });
    assert.deepEqual(
      generated.files.filter((entry) => "target" in entry),
      [
        { path: "Framework.framework/Framework", target: "Versions/Current/Framework" },
        { path: "Framework.framework/Versions/Current", target: "A" },
      ],
    );
    assert.deepEqual(await verifyArtifactInventory(root, generated), {
      valid: true,
      problems: [],
    });

    await symlink("B", join(root, "replacement"));
    await rm(join(root, "Framework.framework", "Versions", "Current"));
    await rename(
      join(root, "replacement"),
      join(root, "Framework.framework", "Versions", "Current"),
    );
    assert.deepEqual(await verifyArtifactInventory(root, generated), {
      valid: false,
      problems: [{ path: "Framework.framework/Versions/Current", reason: "target" }],
    });
  },
);

test(
  "rejects absolute, escaping, and dangling symlinks",
  { skip: process.platform === "win32" && "release symlinks exist only in macOS artifacts" },
  async (t) => {
    for (const [name, target] of [
      ["absolute", "/tmp"],
      ["escaping", "../outside"],
      ["dangling", "missing"],
    ] as const) {
      const root = temporaryDirectory(`cinba-inventory-${name}-`, t);
      await writeFile(join(root, "file"), "file");
      await symlink(target, join(root, "link"));
      await assert.rejects(
        createArtifactInventory(root, {
          version: "0.1.0",
          revision: REVISION,
          target: "macos-arm64",
        }),
        name === "dangling" ? /dangling symlink/ : /unsafe symlink/,
      );
    }
  },
);

test("reports tampered, missing, and unexpected files without trusting names from disk", async (t) => {
  const root = temporaryDirectory("cinba-inventory-", t);
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "cinba.exe"), "wrong");
  await writeFile(join(root, "extra.txt"), "extra");
  const parsed = parseArtifactInventory(
    inventory([
      { path: "bin/cinba.exe", size: 5, sha256: digest("cinba"), executable: false },
      { path: "runtime/node.exe", size: 4, sha256: digest("node"), executable: false },
    ]),
  );

  assert.deepEqual(await verifyArtifactInventory(root, parsed), {
    valid: false,
    problems: [
      { path: "bin/cinba.exe", reason: "sha256" },
      { path: "extra.txt", reason: "unexpected" },
      { path: "runtime/node.exe", reason: "missing" },
    ],
  });
});
