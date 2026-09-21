import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { stopLocalCore } from "@cinba/core-manager";
import { type PlatformServiceAdapter, resolveProductPaths } from "@cinba/installer";
import { createInstalledSyncHostManager } from "./installed-sync-host.ts";
import { createProductCoreConfig } from "./product-service.ts";

const REVISION = "a".repeat(40);

function stoppedServiceAdapter(): PlatformServiceAdapter {
  return {
    inspect: async () => ({ registered: false, running: false }),
    install: async () => undefined,
    remove: async () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
  };
}

async function createSourcePayload(root: string): Promise<string> {
  const payloadRoot = join(root, "payload");
  await Promise.all([
    mkdir(join(payloadRoot, "lib"), { recursive: true }),
    mkdir(join(payloadRoot, "extensions"), { recursive: true }),
    mkdir(join(payloadRoot, "web"), { recursive: true }),
    mkdir(join(payloadRoot, "sync-web"), { recursive: true }),
  ]);
  const coreEntry = pathToFileURL(join(process.cwd(), "packages", "server", "src", "index.ts"));
  const syncEntry = pathToFileURL(
    join(process.cwd(), "packages", "sync-server", "src", "service-entry.ts"),
  );
  await Promise.all([
    writeFile(
      join(payloadRoot, "lib", "core.mjs"),
      `import { startService } from ${JSON.stringify(coreEntry.href)};\nstartService();\n`,
    ),
    writeFile(join(payloadRoot, "lib", "sync.mjs"), `import ${JSON.stringify(syncEntry.href)};\n`),
    writeFile(join(payloadRoot, "web", "index.html"), "Cinba test web"),
    writeFile(join(payloadRoot, "sync-web", "index.html"), "Cinba Sync test web"),
  ]);
  return payloadRoot;
}

test("an installed manager creates, bootstraps, inspects, and deletes a Host with real processes", async () => {
  const platform = process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`unsupported test platform: ${platform}`);
  }
  const root = await mkdtemp(join(tmpdir(), "cinba-installed-sync-host-e2e-"));
  const payloadRoot = await createSourcePayload(root);
  const homeDirectory = join(root, "home");
  const environment =
    platform === "win32"
      ? { ...process.env, LOCALAPPDATA: join(root, "local-app-data") }
      : {
          ...process.env,
          XDG_CONFIG_HOME: join(root, "xdg-config"),
          XDG_DATA_HOME: join(root, "xdg-data"),
          XDG_STATE_HOME: join(root, "xdg-state"),
        };
  const adapter = stoppedServiceAdapter();
  const release = { version: "0.1.0", revision: REVISION, protocolVersion: 1 };
  const options = { platform, homeDirectory, environment, adapter };
  const coreConfig = createProductCoreConfig(payloadRoot, {
    platform,
    homeDirectory,
    environment,
    release,
  });

  try {
    const manager = createInstalledSyncHostManager(payloadRoot, release, options);
    assert.deepEqual(await manager.inspect(), { schemaVersion: 1, state: "not-created" });

    const creation = await manager.create();
    assert.match(creation.setupCode ?? "", /^[A-Za-z0-9_-]+$/);
    assert.equal(creation.status.state, "created");
    assert.equal(creation.status.publicOrigin, "http://127.0.0.1:4518");
    assert.equal(creation.status.mode, "on-demand");
    assert.equal(creation.status.running, false);

    const paths = resolveProductPaths({ platform, homeDirectory, environment });
    assert.equal((await manager.inspect()).state, "created");
    assert.deepEqual(await manager.delete(), { schemaVersion: 1, state: "not-created" });
    await assert.rejects(rm(paths.syncDataDirectory), { code: "ENOENT" });
  } catch (cause) {
    const log = await readFile(coreConfig.logPath, "utf8").catch(() => "Core log unavailable");
    throw new Error(`installed Sync Host flow failed:\n${log}`, { cause });
  } finally {
    await stopLocalCore({ config: coreConfig }).catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
