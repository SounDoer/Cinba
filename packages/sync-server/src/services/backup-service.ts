import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { decryptCredential } from "../security/credentials.ts";
import { parseSyncState } from "../store/schema.ts";
import { createSyncStore } from "../store/sync-store.ts";

const ARCHIVE_KIND = "cinba-sync-backup";
const ARCHIVE_VERSION = 1;
const SCRYPT_COST = 32_768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

type BackupEnvelope = {
  kind: typeof ARCHIVE_KIND;
  version: typeof ARCHIVE_VERSION;
  kdf: {
    algorithm: "scrypt";
    salt: string;
    cost: typeof SCRYPT_COST;
    blockSize: typeof SCRYPT_BLOCK_SIZE;
    parallelization: typeof SCRYPT_PARALLELIZATION;
  };
  cipher: {
    algorithm: "aes-256-gcm";
    nonce: string;
    tag: string;
    ciphertext: string;
  };
};

type BackupPayload = {
  version: 1;
  state: string;
  credentialKey: string;
};

export type SyncStateStatus =
  | { state: "absent" }
  | {
      state: "setup-required" | "ready" | "unavailable";
      serverId?: string;
      setupCode?: string;
    };

export function syncMaintenancePath(directory: string): string {
  const target = resolve(directory);
  return join(dirname(target), `.${basename(target)}.maintenance.lock`);
}

function acquireMaintenance(directory: string): () => void {
  const path = syncMaintenancePath(directory);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const descriptor = openSync(path, "wx", 0o600);
  writeFileSync(
    descriptor,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    {
      flush: true,
    },
  );
  closeSync(descriptor);
  return () => {
    try {
      unlinkSync(path);
    } catch {
      // A missing lock already means maintenance ended.
    }
  };
}

function deriveKey(password: string, salt: Buffer): Buffer {
  if (password.length < 12) {
    throw new Error("Migration password must contain at least 12 characters");
  }
  return scryptSync(password, salt, 32, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: 64 * 1024 * 1024,
  });
}

function privateAtomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", flush: true, mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may never have been created or may already be the target.
    }
    throw error;
  }
}

function encodeArchive(payload: BackupPayload, password: string): string {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(password, salt), nonce);
  cipher.setAAD(Buffer.from(`${ARCHIVE_KIND}:${ARCHIVE_VERSION}`));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
  ]);
  const envelope: BackupEnvelope = {
    kind: ARCHIVE_KIND,
    version: ARCHIVE_VERSION,
    kdf: {
      algorithm: "scrypt",
      salt: salt.toString("base64"),
      cost: SCRYPT_COST,
      blockSize: SCRYPT_BLOCK_SIZE,
      parallelization: SCRYPT_PARALLELIZATION,
    },
    cipher: {
      algorithm: "aes-256-gcm",
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    },
  };
  return JSON.stringify(envelope);
}

function canonicalBase64(value: unknown, bytes?: number): Buffer {
  if (typeof value !== "string") {
    throw new Error("Backup archive is malformed");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (bytes !== undefined && decoded.length !== bytes)) {
    throw new Error("Backup archive is malformed");
  }
  return decoded;
}

function decodeArchive(contents: string, password: string): BackupPayload {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw new Error("Backup archive is malformed or truncated");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Backup archive is malformed");
  }
  const envelope = value as Partial<BackupEnvelope>;
  if (envelope.kind !== ARCHIVE_KIND || envelope.version !== ARCHIVE_VERSION) {
    throw new Error("Backup archive version is unsupported");
  }
  if (
    envelope.kdf?.algorithm !== "scrypt" ||
    envelope.kdf.cost !== SCRYPT_COST ||
    envelope.kdf.blockSize !== SCRYPT_BLOCK_SIZE ||
    envelope.kdf.parallelization !== SCRYPT_PARALLELIZATION ||
    envelope.cipher?.algorithm !== "aes-256-gcm"
  ) {
    throw new Error("Backup archive uses unsupported encryption parameters");
  }
  try {
    const salt = canonicalBase64(envelope.kdf.salt, 16);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(password, salt),
      canonicalBase64(envelope.cipher.nonce, 12),
    );
    decipher.setAAD(Buffer.from(`${ARCHIVE_KIND}:${ARCHIVE_VERSION}`));
    decipher.setAuthTag(canonicalBase64(envelope.cipher.tag, 16));
    const plaintext = Buffer.concat([
      decipher.update(canonicalBase64(envelope.cipher.ciphertext)),
      decipher.final(),
    ]);
    const payload = JSON.parse(plaintext.toString("utf8")) as Partial<BackupPayload>;
    if (
      payload.version !== 1 ||
      typeof payload.state !== "string" ||
      typeof payload.credentialKey !== "string"
    ) {
      throw new Error("invalid payload");
    }
    return payload as BackupPayload;
  } catch {
    throw new Error("Backup password is incorrect or archive integrity verification failed");
  }
}

function validatePayload(payload: BackupPayload): { state: string; key: Buffer } {
  const parsed = parseSyncState(JSON.parse(payload.state) as unknown);
  const key = canonicalBase64(payload.credentialKey, 32);
  for (const envelope of Object.values(parsed.credentials)) {
    decryptCredential(envelope, key);
  }
  if (parsed.setupCodeDisplay) {
    decryptCredential(parsed.setupCodeDisplay, key);
  }
  for (const enrollment of parsed.enrollments) {
    if (enrollment.credentialDelivery) {
      decryptCredential(enrollment.credentialDelivery, key);
    }
  }
  return { state: JSON.stringify(parsed, null, 2), key };
}

export function inspectSyncState(directory: string): SyncStateStatus {
  const statePath = join(directory, "state.json");
  const keyPath = join(directory, "credential-key");
  if (!existsSync(statePath) && !existsSync(keyPath)) {
    return { state: "absent" };
  }
  const store = createSyncStore(directory);
  if (store.problem()) {
    return { state: "unavailable" };
  }
  const state = store.authenticationState();
  return {
    state,
    serverId: store.serverId(),
    ...(state === "setup-required" ? { setupCode: store.localSetupCode() } : {}),
  };
}

export function backupSyncState(directory: string, outputPath: string, password: string): void {
  const release = acquireMaintenance(directory);
  try {
    const state = readFileSync(join(directory, "state.json"), "utf8");
    parseSyncState(JSON.parse(state) as unknown);
    const credentialKey = readFileSync(join(directory, "credential-key"));
    if (credentialKey.length !== 32) {
      throw new Error("credential-key has an invalid length");
    }
    privateAtomicWrite(
      resolve(outputPath),
      encodeArchive(
        { version: 1, state, credentialKey: credentialKey.toString("base64") },
        password,
      ),
    );
  } finally {
    release();
  }
}

export function restoreSyncState(
  directory: string,
  inputPath: string,
  password: string,
  options: { force?: boolean } = {},
): string | undefined {
  const release = acquireMaintenance(directory);
  try {
    const payload = validatePayload(
      decodeArchive(readFileSync(resolve(inputPath), "utf8"), password),
    );
    const target = resolve(directory);
    const nonempty = existsSync(target) && readdirSync(target).length > 0;
    if (nonempty && !options.force) {
      throw new Error("Restore target is not empty; use --force to preserve and replace it");
    }
    const parent = dirname(target);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const staged = join(
      parent,
      `.${basename(target)}.restore-${process.pid}-${randomBytes(6).toString("hex")}`,
    );
    const preserved = nonempty
      ? `${target}.before-restore-${new Date().toISOString().replaceAll(":", "-")}`
      : undefined;
    try {
      mkdirSync(staged, { mode: 0o700 });
      writeFileSync(join(staged, "state.json"), payload.state, {
        flag: "wx",
        flush: true,
        mode: 0o600,
      });
      writeFileSync(join(staged, "credential-key"), payload.key, {
        flag: "wx",
        flush: true,
        mode: 0o600,
      });
      if (createSyncStore(staged).problem()) {
        throw new Error("Restored state failed validation");
      }
      if (preserved) {
        renameSync(target, preserved);
      }
      renameSync(staged, target);
      return preserved;
    } catch (error) {
      rmSync(staged, { recursive: true, force: true });
      if (preserved && existsSync(preserved) && !existsSync(target)) {
        renameSync(preserved, target);
      }
      throw error;
    }
  } finally {
    release();
  }
}
