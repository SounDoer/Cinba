import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type LockRecord = {
  pid: number;
  token: string;
};

export type StartLockOptions = {
  timeoutMs?: number;
  retryMs?: number;
  processId?: number;
  isProcessAlive?: (pid: number) => boolean;
  delay?: (milliseconds: number) => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_MS = 100;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(path: string): LockRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockRecord>;
    return Number.isInteger(parsed.pid) && typeof parsed.token === "string"
      ? (parsed as LockRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

function removeOwnedLock(path: string, token: string): void {
  if (readLock(path)?.token !== token) {
    return;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

/** Acquire the cross-process lock used only around Core discovery and startup. */
export async function acquireStartLock(
  path: string,
  options: StartLockOptions = {},
): Promise<() => void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const ownerPid = options.processId ?? process.pid;
  const alive = options.isProcessAlive ?? processIsAlive;
  const delay =
    options.delay ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();

  mkdirSync(dirname(path), { recursive: true });

  while (true) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify({ pid: ownerPid, token } satisfies LockRecord));
      } finally {
        closeSync(descriptor);
      }
      return () => removeOwnedLock(path, token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    const existing = readLock(path);
    if (!existing) {
      // The winning process creates the file before it can fill in the record.
      // Give that tiny window the same bounded wait as an ordinary live lock.
      if (Date.now() >= deadline) {
        throw new Error(`Core start lock is unreadable: ${path}`);
      }
      await delay(retryMs);
      continue;
    }
    if (!alive(existing.pid)) {
      removeOwnedLock(path, existing.token);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for another Cinba client to start the Core`);
    }
    await delay(retryMs);
  }
}
