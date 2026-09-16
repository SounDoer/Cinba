import assert from "node:assert/strict";
import test from "node:test";
import {
  CredentialDecryptionError,
  decryptCredential,
  encryptCredential,
  generateCredentialKey,
  hashSecret,
  verifySecret,
} from "./credentials.ts";

function tamper(value: string): string {
  const bytes = Buffer.from(value, "base64");
  bytes[0] ^= 1;
  return bytes.toString("base64");
}

test("credential encryption is randomized and authenticated", () => {
  const key = generateCredentialKey();
  const first = encryptCredential("shared-provider-secret", key);
  const second = encryptCredential("shared-provider-secret", key);

  assert.notDeepEqual(first, second);
  assert.equal(decryptCredential(first, key), "shared-provider-secret");
  assert.equal(decryptCredential(second, key), "shared-provider-secret");
});

for (const field of ["nonce", "tag", "ciphertext"] as const) {
  test(`tampering with credential ${field} fails authentication`, () => {
    const key = generateCredentialKey();
    const envelope = encryptCredential("shared-provider-secret", key);
    const changed = { ...envelope, [field]: tamper(envelope[field]) };

    assert.throws(() => decryptCredential(changed, key), CredentialDecryptionError);
  });
}

test("salted token hashes verify without retaining the original token", () => {
  const token = "one-time-core-token";
  const first = hashSecret(token);
  const second = hashSecret(token);

  assert.notDeepEqual(first, second);
  assert.equal(verifySecret(token, first), true);
  assert.equal(verifySecret("wrong-token", first), false);
  assert.equal(JSON.stringify(first).includes(token), false);
});
