import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsConflictError, SyncStoreUnavailableError, createSyncStore } from "./sync-store.ts";

function fixture(): { directory: string; close(): void } {
  const directory = mkdtempSync(join(tmpdir(), "cinba-sync-store-"));
  return {
    directory,
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function readState(directory: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as Record<string, unknown>;
}

function settings(modelId: string) {
  return {
    version: 1 as const,
    defaultModel: { provider: "deepseek", id: modelId },
    webTools: { searchPrimary: "exa" as const },
  };
}

test("first initialization and restart retain one stable server identity", () => {
  const files = fixture();
  try {
    const first = createSyncStore(files.directory);
    const serverId = first.serverId();
    assert.equal(existsSync(join(files.directory, "state.json")), true);
    assert.equal(readFileSync(join(files.directory, "credential-key")).byteLength, 32);

    const restarted = createSyncStore(files.directory);
    assert.equal(restarted.problem(), undefined);
    assert.equal(restarted.serverId(), serverId);
    assert.deepEqual(restarted.settings(), {
      version: 1,
      settingsRevision: 0,
      syncRevision: 0,
      settings: { version: 1, webTools: { searchPrimary: "auto" } },
    });
  } finally {
    files.close();
  }
});

test("an interrupted first initialization leaves no half-created key or state", () => {
  const files = fixture();
  try {
    const store = createSyncStore(files.directory, {
      atomicWrite: {
        beforeReplace: () => {
          throw new Error("simulated initialization interruption");
        },
      },
    });

    assert.ok(store.problem());
    assert.deepEqual(readdirSync(files.directory), []);
  } finally {
    files.close();
  }
});

test("concurrent mutations are serialized with continuous Sync revisions", async () => {
  const files = fixture();
  try {
    const store = createSyncStore(files.directory);
    assert.deepEqual(
      await Promise.all([
        store.setCredential("provider-a", "secret-a"),
        store.setCredential("provider-b", "secret-b"),
        store.setCredential("provider-c", "secret-c"),
      ]),
      [1, 2, 3],
    );
    assert.equal(store.snapshot(false).syncRevision, 3);
    assert.equal(store.history().length, 1);
  } finally {
    files.close();
  }
});

test("Settings, Credential, and rollback mutations use their distinct revision rules", async () => {
  const files = fixture();
  try {
    let tick = 0;
    const store = createSyncStore(files.directory, {
      now: () => {
        const current = new Date(Date.UTC(2026, 8, 16, 0, 0, tick));
        tick += 1;
        return current;
      },
    });
    assert.deepEqual(await store.updateSettings(0, settings("v1")), {
      version: 1,
      settingsRevision: 1,
      syncRevision: 1,
      settings: settings("v1"),
    });
    assert.equal(await store.setCredential("deepseek", "seed-shared-secret"), 2);
    assert.deepEqual(await store.rollbackSettings(1, 0), {
      version: 1,
      settingsRevision: 2,
      syncRevision: 3,
      settings: { version: 1, webTools: { searchPrimary: "auto" } },
    });

    assert.deepEqual(
      store.history().map((entry) => [entry.settingsRevision, entry.syncRevision]),
      [
        [0, 0],
        [1, 1],
        [2, 3],
      ],
    );
    assert.equal(JSON.stringify(store.history()).includes("seed-shared-secret"), false);
    assert.equal(store.snapshot(false).credentials, undefined);
    assert.deepEqual(store.snapshot(true).credentials, { deepseek: "seed-shared-secret" });
  } finally {
    files.close();
  }
});

test("a stale Settings revision is rejected without changing current data", async () => {
  const files = fixture();
  try {
    const store = createSyncStore(files.directory);
    await store.updateSettings(0, settings("current"));
    const before = readFileSync(join(files.directory, "state.json"), "utf8");

    await assert.rejects(store.updateSettings(0, settings("stale")), (error: unknown) => {
      assert.ok(error instanceof SettingsConflictError);
      assert.equal(error.currentSettingsRevision, 1);
      return true;
    });
    assert.equal(readFileSync(join(files.directory, "state.json"), "utf8"), before);
    assert.equal(store.settings().settings.defaultModel?.id, "current");
  } finally {
    files.close();
  }
});

test("credentials persist only as ciphertext and decrypt after restart", async () => {
  const files = fixture();
  try {
    const store = createSyncStore(files.directory);
    await store.setCredential("deepseek", "plaintext-api-key");
    const disk = readFileSync(join(files.directory, "state.json"), "utf8");

    assert.equal(disk.includes("plaintext-api-key"), false);
    assert.equal(createSyncStore(files.directory).credential("deepseek"), "plaintext-api-key");
  } finally {
    files.close();
  }
});

test("an interrupted atomic write retains the old complete file and removes its temporary file", async () => {
  const files = fixture();
  try {
    let interrupt = false;
    const store = createSyncStore(files.directory, {
      atomicWrite: {
        beforeReplace: () => {
          if (interrupt) {
            throw new Error("simulated interruption");
          }
        },
      },
    });
    const before = readFileSync(join(files.directory, "state.json"), "utf8");
    interrupt = true;

    await assert.rejects(store.setCredential("deepseek", "must-not-land"), /interruption/);
    assert.equal(readFileSync(join(files.directory, "state.json"), "utf8"), before);
    assert.deepEqual(readdirSync(files.directory).toSorted(), ["credential-key", "state.json"]);
  } finally {
    files.close();
  }
});

test("copying state.json without credential-key cannot reveal or mutate credentials", async () => {
  const source = fixture();
  const copy = fixture();
  try {
    const store = createSyncStore(source.directory);
    await store.setCredential("deepseek", "copy-protected-secret");
    copyFileSync(join(source.directory, "state.json"), join(copy.directory, "state.json"));

    const isolated = createSyncStore(copy.directory);
    assert.ok(isolated.problem());
    assert.throws(() => isolated.snapshot(true), SyncStoreUnavailableError);
    await assert.rejects(
      isolated.setCredential("deepseek", "replacement"),
      SyncStoreUnavailableError,
    );
    assert.equal(
      readFileSync(join(copy.directory, "state.json"), "utf8").includes("copy-protected-secret"),
      false,
    );
  } finally {
    source.close();
    copy.close();
  }
});

test("corrupt, unknown-version, and missing-key stores fail closed without overwrite", async () => {
  for (const damage of ["corrupt", "unknown-version", "missing-key"] as const) {
    const files = fixture();
    try {
      createSyncStore(files.directory);
      const path = join(files.directory, "state.json");
      if (damage === "corrupt") {
        writeFileSync(path, "{ broken");
      } else if (damage === "unknown-version") {
        const state = readState(files.directory);
        writeFileSync(path, JSON.stringify({ ...state, version: 99 }));
      } else {
        unlinkSync(join(files.directory, "credential-key"));
      }
      const original = readFileSync(path, "utf8");
      const store = createSyncStore(files.directory);

      assert.ok(store.problem(), damage);
      assert.equal(store.problem()?.cause, undefined);
      await assert.rejects(
        store.setCredential("deepseek", "replacement"),
        SyncStoreUnavailableError,
      );
      assert.equal(readFileSync(path, "utf8"), original);
    } finally {
      files.close();
    }
  }
});

test("non-monotonic history revisions make a store read-only", async () => {
  const files = fixture();
  try {
    const store = createSyncStore(files.directory);
    await store.updateSettings(0, settings("current"));
    const state = readState(files.directory);
    const history = state.history as Array<{ settingsRevision: number }>;
    history[1]!.settingsRevision = 0;
    writeFileSync(join(files.directory, "state.json"), JSON.stringify(state));

    assert.ok(createSyncStore(files.directory).problem());
  } finally {
    files.close();
  }
});

test("a credential authentication failure makes the whole store read-only", async () => {
  const files = fixture();
  try {
    const store = createSyncStore(files.directory);
    await store.setCredential("deepseek", "authenticated-secret");
    const state = readState(files.directory);
    const credentials = state.credentials as Record<
      string,
      { version: 1; algorithm: "aes-256-gcm"; nonce: string; tag: string; ciphertext: string }
    >;
    const bytes = Buffer.from(credentials.deepseek!.tag, "base64");
    bytes[0] ^= 1;
    credentials.deepseek!.tag = bytes.toString("base64");
    writeFileSync(join(files.directory, "state.json"), JSON.stringify(state));

    const reopened = createSyncStore(files.directory);
    assert.ok(reopened.problem());
    assert.throws(() => reopened.credential("deepseek"), SyncStoreUnavailableError);
  } finally {
    files.close();
  }
});
