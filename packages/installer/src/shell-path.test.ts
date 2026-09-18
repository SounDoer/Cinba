import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configurePosixLauncherPath, removePosixLauncherPathBlock } from "./shell-path.ts";

test(
  "an existing launcher PATH needs no profile edit",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cinba-shell-path-existing-"));
    try {
      assert.deepEqual(
        await configurePosixLauncherPath({
          homeDirectory: root,
          launcherDirectory: join(root, ".local", "bin"),
          currentPath: `/usr/bin:${join(root, ".local", "bin")}`,
          shell: "/bin/bash",
        }),
        { state: "already-available" },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("Bash and Zsh receive one reversible managed block", async () => {
  for (const [shell, file] of [
    ["/bin/bash", ".bashrc"],
    ["/bin/zsh", ".zshrc"],
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), "cinba-shell-path-managed-"));
    const profilePath = join(root, file);
    try {
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("unsupported shells are left to the user", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-shell-path-manual-"));
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "symlinked profiles are left to the user",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cinba-shell-path-symlink-"));
    try {
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a damaged marker block is never duplicated or removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-shell-path-damaged-"));
  const profilePath = join(root, ".bashrc");
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
