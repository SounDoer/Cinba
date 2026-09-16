import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type CredentialEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  nonce: string;
  tag: string;
  ciphertext: string;
};

export type SecretHash = {
  version: 1;
  algorithm: "scrypt";
  salt: string;
  digest: string;
  cost: 16_384;
  blockSize: 8;
  parallelization: 1;
};

export class CredentialDecryptionError extends Error {
  constructor() {
    super("Stored credential authentication failed");
    this.name = "CredentialDecryptionError";
  }
}

export function generateCredentialKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function assertCredentialKey(key: Uint8Array): Buffer {
  if (key.byteLength !== KEY_BYTES) {
    throw new Error("Credential key must contain exactly 32 bytes");
  }
  return Buffer.from(key);
}

export function encryptCredential(plaintext: string, key: Uint8Array): CredentialEnvelope {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", assertCredentialKey(key), nonce, {
    authTagLength: TAG_BYTES,
  });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptCredential(envelope: CredentialEnvelope, key: Uint8Array): string {
  try {
    const nonce = Buffer.from(envelope.nonce, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    if (nonce.byteLength !== NONCE_BYTES || tag.byteLength !== TAG_BYTES) {
      throw new Error("invalid envelope length");
    }
    const decipher = createDecipheriv("aes-256-gcm", assertCredentialKey(key), nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new CredentialDecryptionError();
  }
}

export function hashSecret(secret: string): SecretHash {
  if (secret === "") {
    throw new Error("Secret must not be empty");
  }
  const salt = randomBytes(16);
  const digest = scryptSync(secret, salt, 32, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return {
    version: 1,
    algorithm: "scrypt",
    salt: salt.toString("base64"),
    digest: digest.toString("base64"),
    cost: 16_384,
    blockSize: 8,
    parallelization: 1,
  };
}

export function verifySecret(secret: string, stored: SecretHash): boolean {
  try {
    const expected = Buffer.from(stored.digest, "base64");
    const actual = scryptSync(secret, Buffer.from(stored.salt, "base64"), expected.byteLength, {
      N: stored.cost,
      r: stored.blockSize,
      p: stored.parallelization,
      maxmem: 64 * 1024 * 1024,
    });
    return expected.byteLength > 0 && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
