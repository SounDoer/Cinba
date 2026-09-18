import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ProductRelease } from "@cinba/product-runtime";
import { resolveDesktopRuntime, startDesktopAutomaticUpdate } from "./desktop-runtime.ts";

const release: ProductRelease = {
  schemaVersion: 1,
  product: "Cinba",
  version: "0.1.0",
  revision: "a".repeat(40),
  protocolVersion: 1,
  dataFormatVersion: 1,
  target: "windows-x64",
  nodeVersion: "24.0.0",
};

test("source Desktop stays inside the Cinba Dev identity", () => {
  const repository = resolve("repository");
  assert.deepEqual(
    resolveDesktopRuntime({
      packaged: false,
      modulePath: join(repository, "packages", "desktop", "src", "main.ts"),
      resourcesPath: resolve("unused"),
    }),
    {
      identity: "development",
      displayName: "Cinba Dev",
      applicationId: "com.soundoer.cinba.dev",
      repositoryRoot: repository,
    },
  );
});

test("packaged Desktop uses only the active installed release payload", () => {
  const payload = resolve("releases", "a".repeat(40));
  assert.deepEqual(
    resolveDesktopRuntime({
      packaged: true,
      modulePath: resolve("app", "lib", "desktop.mjs"),
      resourcesPath: resolve("resources"),
      installedPayloadRoot: payload,
    }),
    {
      identity: "release",
      displayName: "Cinba",
      applicationId: "com.soundoer.cinba",
      payloadRoot: payload,
    },
  );
});

test("packaged Desktop never falls back to a payload beside the app shell", () => {
  assert.throws(
    () =>
      resolveDesktopRuntime({
        packaged: true,
        modulePath: resolve("app", "lib", "desktop.mjs"),
        resourcesPath: resolve("resources"),
      }),
    { message: "packaged Desktop requires an absolute installed payload root" },
  );
});

test("release Desktop starts a fire-and-forget automatic update check", async () => {
  let received:
    | {
        release: ProductRelease;
        paths: { stateDirectory: string; cacheDirectory: string };
        signal?: AbortSignal;
      }
    | undefined;
  let completed = false;
  const started = startDesktopAutomaticUpdate(
    {
      runtime: { identity: "release" },
      release,
      paths: { stateDirectory: "C:\\state", cacheDirectory: "C:\\cache" },
      onUpdate: () => {},
    },
    async (options) => {
      received = options;
      return await new Promise(() => {});
    },
  );

  completed = true;
  assert.equal(completed, true);
  assert.equal(received?.release, release);
  assert.equal(received?.signal?.aborted, false);
  assert.ok(started);
  started.abort();
  assert.equal(received?.signal?.aborted, true);
});

test("development Desktop never starts automatic update checks", () => {
  let checks = 0;

  const started = startDesktopAutomaticUpdate(
    { runtime: { identity: "development" } },
    async () => {
      checks += 1;
    },
  );

  assert.equal(started, undefined);
  assert.equal(checks, 0);
});

test("automatic update rejection stays detached from Desktop startup", async () => {
  const started = startDesktopAutomaticUpdate(
    {
      runtime: { identity: "release" },
      release,
      paths: { stateDirectory: "C:\\state", cacheDirectory: "C:\\cache" },
      onUpdate: () => {},
    },
    async () => {
      throw new Error("network details");
    },
  );

  await new Promise<void>((settle) => setImmediate(settle));
  assert.ok(started);
  started.abort();
});
