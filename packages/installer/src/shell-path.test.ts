import assert from "node:assert/strict";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import { configurePosixLauncherPath, removePosixLauncherPathBlock } from "./shell-path.ts";

test(
  "an existing launcher PATH needs no profile edit",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = temporaryDirectory("cinba-shell-path-existing-", t);
    assert.deepEqual(
      await configurePosixLauncherPath({
        homeDirectory: root,
        launcherDirectory: join(root, ".local", "bin"),
        currentPath: `/usr/bin:${join(root, ".local", "bin")}`,
        shell: "/bin/bash",
      }),
      { state: "already-available" },
    );
  },
);

test("Bash and Zsh receive one reversible managed block", async (t) => {
  for (const [shell, file] of [
    ["/bin/bash", ".bashrc"],
    ["/bin/zsh", ".zshrc"],
  ] as const) {
    const root = temporaryDirectory("cinba-shell-path-managed-", t);
    const profilePath = join(root, file);
    await writeFile(profilePath, "export EDITOR=vim\n");
    const options = {
      homeDirectory: root,
      launcherDirectory: join(root, ".local", "bin"),
      currentPath: "/usr/bin",
      shell,
    };
    assert.deepEqual(await configurePosixLauncherPath(options), {
      state: "profile-updated",
      profilePath,
    });
    await configurePosixLauncherPath(options);
    const configured = await readFile(profilePath, "utf8");
    assert.equal(configured.match(/# >>> Cinba CLI >>>/g)?.length, 1);
    assert.match(configured, /export EDITOR=vim/);
    assert.equal(await removePosixLauncherPathBlock(profilePath), true);
    assert.equal(await readFile(profilePath, "utf8"), "export EDITOR=vim\n");
    assert.equal(await removePosixLauncherPathBlock(profilePath), false);
  }
});

test("unsupported shells are left to the user", async (t) => {
  const root = temporaryDirectory("cinba-shell-path-manual-", t);
  const launcherDirectory = join(root, ".local", "bin");
  assert.equal(
    (
      await configurePosixLauncherPath({
        homeDirectory: root,
        launcherDirectory,
        currentPath: "/usr/bin",
        shell: "/usr/bin/fish",
      })
    ).state,
    "manual",
  );
});

test(
  "symlinked profiles are left to the user",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = temporaryDirectory("cinba-shell-path-symlink-", t);
    const target = join(root, "shared-zshrc");
    await writeFile(target, "export EDITOR=nano\n");
    await symlink(target, join(root, ".zshrc"));
    assert.equal(
      (
        await configurePosixLauncherPath({
          homeDirectory: root,
          launcherDirectory: join(root, ".local", "bin"),
          currentPath: "/usr/bin",
          shell: "/bin/zsh",
        })
      ).state,
      "manual",
    );
    assert.equal(await readFile(target, "utf8"), "export EDITOR=nano\n");
  },
);

test("a damaged marker block is never duplicated or removed", async (t) => {
  const root = temporaryDirectory("cinba-shell-path-damaged-", t);
  const profilePath = join(root, ".bashrc");
  await writeFile(profilePath, "# >>> Cinba CLI >>>\nexport PATH=broken\n");
  await assert.rejects(
    configurePosixLauncherPath({
      homeDirectory: root,
      launcherDirectory: join(root, ".local", "bin"),
      currentPath: "/usr/bin",
      shell: "/bin/bash",
    }),
    /damaged/,
  );
  assert.equal(await readFile(profilePath, "utf8"), "# >>> Cinba CLI >>>\nexport PATH=broken\n");
});
