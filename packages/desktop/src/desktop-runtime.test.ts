import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveDesktopRuntime } from "./desktop-runtime.ts";

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

test("packaged Desktop uses only the bundled release payload", () => {
  const resources = resolve("resources");
  assert.deepEqual(
    resolveDesktopRuntime({
      packaged: true,
      modulePath: resolve("app", "lib", "desktop.mjs"),
      resourcesPath: resources,
    }),
    {
      identity: "release",
      displayName: "Cinba",
      applicationId: "com.soundoer.cinba",
      payloadRoot: join(resources, "payload"),
    },
  );
});
