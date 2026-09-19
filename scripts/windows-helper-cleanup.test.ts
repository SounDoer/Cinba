import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scheduleWindowsHelperDirectoryRemoval } from "./windows-helper-cleanup.ts";

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

test(
  "a copied helper's directory is removed once the helper stops running",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cinba-uninstall-cleanup-test-"));
    try {
      const helper = join(directory, "cinba-helper.exe");
      await copyFile(process.execPath, helper);
      const running = spawn(helper, ["-e", "setTimeout(() => {}, 2000)"], {
        stdio: "ignore",
        windowsHide: true,
      });
      await new Promise<void>((resolve, reject) => {
        running.once("spawn", resolve);
        running.once("error", reject);
      });
      const exited = new Promise((resolve) => running.once("exit", resolve));

      const failureLog = join(`${directory}-logs`, "uninstall-helper.log");
      scheduleWindowsHelperDirectoryRemoval(directory, { failureLog });

      await exited;
      for (let attempt = 0; attempt < 150 && (await exists(directory)); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(await exists(directory), false);
      assert.equal(await exists(failureLog), false);
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test(
  "a directory that stays locked is reported in the failure log",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cinba-uninstall-cleanup-failure-test-"));
    const directory = join(root, "program");
    const failureLog = join(root, "Logs", "uninstall-helper.log");
    await mkdir(directory);
    const locked = join(directory, "Cinba.exe");
    await copyFile(process.execPath, locked);
    const running = spawn(locked, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      running.once("spawn", resolve);
      running.once("error", reject);
    });
    try {
      scheduleWindowsHelperDirectoryRemoval(directory, { failureLog, attempts: 2 });

      for (let attempt = 0; attempt < 150 && !(await exists(failureLog)); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.match(await readFile(failureLog, "utf8"), /uninstall failed: /);
      assert.equal(await exists(locked), true);
    } finally {
      const exited = new Promise((resolve) => running.once("exit", resolve));
      running.kill();
      await exited;
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
