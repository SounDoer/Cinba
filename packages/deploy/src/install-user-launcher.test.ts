import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  installUserLauncher,
  isDirectExecution,
  userLauncherPaths,
} from "./install-user-launcher.ts";

test("the VPS launcher enters the product CLI with its platform default", async () => {
  const launcherPath = fileURLToPath(new URL("../bin/cinba", import.meta.url));
  const launcher = await readFile(launcherPath, "utf8");

  assert.match(launcher, /"\$cinba_home\/\.local\/node\/bin\/node"/);
  assert.match(launcher, /export CINBA_DEFAULT_PROJECT="\$cinba_home\/Cinba"/);
  assert.match(launcher, /"\$cinba_home\/current\/scripts\/cinba\.ts" "\$@"/);
  assert.match(launcher, /^exec /m);
});

test("launcher paths follow current instead of pinning one release", () => {
  assert.deepEqual(userLauncherPaths("/home/cinba"), {
    binDirectory: "/home/cinba/.local/bin",
    commandPath: "/home/cinba/.local/bin/cinba",
    targetPath: "/home/cinba/current/packages/deploy/bin/cinba",
  });
});

test("installer entry follows current before deciding whether it is directly executed", () => {
  const modulePath = resolve("releases/revision/packages/deploy/src/install-user-launcher.ts");
  const argumentPath = resolve("current/packages/deploy/src/install-user-launcher.ts");
  const canonicalPaths = new Map([
    [modulePath, modulePath],
    [argumentPath, modulePath],
  ]);

  assert.equal(
    isDirectExecution(modulePath, argumentPath, (path) => canonicalPaths.get(path) ?? path),
    true,
  );
});

test("install creates the user bin directory and managed symlink", async () => {
  const calls: string[] = [];
  const result = await installUserLauncher("/home/cinba", {
    async makeDirectory(path) {
      calls.push(`mkdir ${path}`);
    },
    async pathKind(path) {
      calls.push(`kind ${path}`);
      return "missing";
    },
    async createSymlink(target, path) {
      calls.push(`link ${path} -> ${target}`);
    },
  });

  assert.equal(result, "installed");
  assert.deepEqual(calls, [
    "mkdir /home/cinba/.local/bin",
    "kind /home/cinba/.local/bin/cinba",
    "link /home/cinba/.local/bin/cinba -> /home/cinba/current/packages/deploy/bin/cinba",
  ]);
});

test("install is idempotent only for the expected symlink", async () => {
  const common = {
    async makeDirectory() {},
    async pathKind() {
      return "symlink" as const;
    },
  };

  assert.equal(
    await installUserLauncher("/home/cinba", {
      ...common,
      async readLink() {
        return "/home/cinba/current/packages/deploy/bin/cinba";
      },
    }),
    "already_installed",
  );

  await assert.rejects(
    installUserLauncher("/home/cinba", {
      ...common,
      async readLink() {
        return "/tmp/not-cinba";
      },
    }),
    /unexpected target/,
  );
});

test("install refuses unsafe home paths and existing regular files", async () => {
  assert.throws(() => userLauncherPaths("relative"), /absolute POSIX/);
  assert.throws(() => userLauncherPaths("/"), /Filesystem root/);

  await assert.rejects(
    installUserLauncher("/home/cinba", {
      async makeDirectory() {},
      async pathKind() {
        return "other";
      },
    }),
    /not the managed launcher symlink/,
  );
});
