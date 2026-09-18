import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PlatformServiceAdapter } from "@cinba/installer";
import {
  formatProductComponentMode,
  inspectProductComponentMode,
  setProductComponentMode,
} from "./managed-services.ts";

function fakeAdapter(): PlatformServiceAdapter & { registered: boolean; running: boolean } {
  return {
    registered: false,
    running: false,
    async inspect() {
      return { registered: this.registered, running: this.running };
    },
    async install() {
      this.registered = true;
    },
    async remove() {
      this.registered = false;
    },
    async start() {
      this.running = true;
    },
    async stop() {
      this.running = false;
    },
  };
}

test("the product management facade controls Core through the shared service manager", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-product-service-"));
  const adapter = fakeAdapter();
  const options = {
    platform: "win32" as const,
    homeDirectory: root,
    environment: { LOCALAPPDATA: join(root, "Local") },
    adapter,
    verifyHealth: async () => undefined,
  };
  try {
    const initial = await inspectProductComponentMode("core", options);
    assert.equal(initial.state, "on-demand");
    const background = await setProductComponentMode("core", "background", options);
    assert.equal(background.state, "background");
    assert.match(formatProductComponentMode(background), /Service: running/);
    const onDemand = await setProductComponentMode("core", "on-demand", options);
    assert.equal(onDemand.state, "on-demand");
    assert.equal(adapter.registered, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Sync remains not created until its authority directory exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-product-sync-"));
  try {
    const status = await inspectProductComponentMode("sync", {
      platform: "win32",
      homeDirectory: root,
      environment: { LOCALAPPDATA: join(root, "Local") },
      adapter: fakeAdapter(),
    });
    assert.equal(status.state, "not-created");
    assert.equal(formatProductComponentMode(status), "Cinba Sync: not created");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
