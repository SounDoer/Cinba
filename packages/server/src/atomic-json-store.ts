import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

const RETRYABLE_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const RENAME_DELAYS_MS = [5, 15, 30, 50];
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

export class StoredJsonError extends Error {
  readonly path: string;

  constructor(message: string, path: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoredJsonError";
    this.path = path;
  }
}

function renameWithRetry(source: string, target: string): void {
  for (const delay of [0, ...RENAME_DELAYS_MS]) {
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
    // Windows does not support fsync on a directory. The file itself was
    // flushed before rename, so directory durability is best-effort there.
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

/** Write, flush, validate, and atomically replace one JSON document. */
export function writeAtomicJson(
  path: string,
  document: unknown,
  validate: (value: unknown) => void,
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
    renameWithRetry(temporaryPath, path);
    flushDirectoryBestEffort(directory);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not exist or may already be the target.
    }
    throw error;
  }
}

export type LoadedJson<T> =
  | { status: "missing" }
  | { status: "valid"; value: T; document: Record<string, unknown> }
  | { status: "invalid"; error: StoredJsonError };

/** Load once. Invalid existing content is retained and makes the store read-only. */
export function loadStoredJson<T>(path: string, parse: (value: unknown) => T): LoadedJson<T> {
  if (!existsSync(path)) {
    return { status: "missing" };
  }

  try {
    const document = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      throw new Error("expected a JSON object");
    }
    return {
      status: "valid",
      value: parse(document),
      document: document as Record<string, unknown>,
    };
  } catch (cause) {
    return {
      status: "invalid",
      error: new StoredJsonError("Stored JSON is unreadable or unsupported", path, { cause }),
    };
  }
}
