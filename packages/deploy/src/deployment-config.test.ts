import { test } from "node:test";
import assert from "node:assert/strict";
import { deploymentConfig } from "./deployment-config.ts";

test("the VPS layout is derived from only the service user's home", () => {
  assert.deepEqual(deploymentConfig("/home/cinba/"), {
    repoPath: "/home/cinba/Cinba",
    releasesRoot: "/home/cinba/releases",
    currentLink: "/home/cinba/current",
    statusPath: "/home/cinba/.cinba/deployment.json",
    lockPath: "/home/cinba/.cinba/deployment.lock",
    healthUrl: "http://127.0.0.1:4517/healthz",
    webSocketUrl: "ws://127.0.0.1:4517/ws",
  });
});

test("relative paths and filesystem root are refused", () => {
  assert.throws(() => deploymentConfig("home/cinba"), /absolute POSIX path/);
  assert.throws(() => deploymentConfig("/"), /cannot be used/);
});
