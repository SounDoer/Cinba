import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const RETRYABLE_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const RENAME_DELAYS_MS = [0, 5, 15, 30, 50];
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

export type AtomicWriteOptions = {
  beforeReplace?: (temporaryPath: string) => void;
};

function renameWithRetry(source: string, target: string): void {
  for (const delay of RENAME_DELAYS_MS) {
    if (delay > 0) {
      Atomics.wait(waitBuffer, 0, 0, delay);
    }
    try {
      renameSync(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!RETRYABLE_RENAME_CODES.has(code ?? "") || delay === RENAME_DELAYS_MS.at(-1)) {
        throw error;
      }
    }
  }
}

function flushDirectoryBestEffort(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch {
    // Directory fsync is not available on Windows. The file itself has
    // already been flushed; the directory durability step is best-effort.
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

export function writePrivateFileOnce(path: string, contents: Uint8Array): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { flag: "wx", flush: true, mode: 0o600 });
  flushDirectoryBestEffort(directory);
}

export function replaceJsonAtomically(
  path: string,
  document: unknown,
  validate: (value: unknown) => void,
  options: AtomicWriteOptions = {},
): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, JSON.stringify(document, null, 2), {
      encoding: "utf8",
      flag: "wx",
      flush: true,
      mode: 0o600,
    });
    validate(JSON.parse(readFileSync(temporaryPath, "utf8")) as unknown);
    options.beforeReplace?.(temporaryPath);
    renameWithRetry(temporaryPath, path);
    flushDirectoryBestEffort(directory);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // It may already have become the target or never have been created.
    }
    throw error;
  }
}
