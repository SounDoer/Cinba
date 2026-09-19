import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, copyFile, mkdtemp, rm } from "node:fs/promises";
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

      scheduleWindowsHelperDirectoryRemoval(directory);

      await exited;
      for (let attempt = 0; attempt < 150 && (await exists(directory)); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(await exists(directory), false);
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
