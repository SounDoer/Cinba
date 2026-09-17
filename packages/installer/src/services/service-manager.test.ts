import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { InstallationLayout } from "../installation-store.ts";
import { resolveProductPaths } from "../paths.ts";
import { createManagedServiceDefinitions } from "./definitions.ts";
import { type PlatformServiceAdapter, setManagedServiceMode } from "./service-manager.ts";
import { readServiceState } from "./service-state.ts";

function layout(root: string): InstallationLayout {
  return {
    programDirectory: join(root, "program"),
    releasesDirectory: join(root, "program", "releases"),
    transactionDirectory: join(root, "state", "install"),
  };
}

function fakeAdapter(events: string[]): PlatformServiceAdapter & {
  registered: boolean;
  running: boolean;
} {
  return {
    registered: false,
    running: false,
    async inspect() {
      events.push("inspect");
      return { registered: this.registered, running: this.running };
    },
    async install() {
      events.push("install");
      this.registered = true;
    },
    async remove() {
      events.push("remove");
      this.registered = false;
    },
    async start() {
      events.push("start");
      this.running = true;
    },
    async stop() {
      events.push("stop");
      this.running = false;
    },
  };
}

function setup(root: string) {
  const paths = resolveProductPaths({
    platform: "win32",
    homeDirectory: "C:\\Users\\cinba-test",
    environment: { LOCALAPPDATA: "C:\\Users\\cinba-test\\AppData\\Local" },
  });
  return {
    layout: layout(root),
    stateDirectory: join(root, "state", "services"),
    services: createManagedServiceDefinitions(paths, "win32"),
  };
}

test("Background commits only after registration, start, and health", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-service-background-"));
  const context = setup(root);
  const events: string[] = [];
  const adapter = fakeAdapter(events);
  try {
    const status = await setManagedServiceMode(
      {
        layout: context.layout,
        serviceStateDirectory: context.stateDirectory,
        definition: context.services.core,
        adapter,
        availability: { productInstalled: true, componentCreated: true },
        verifyHealth: async () => {
          events.push("health");
        },
      },
      "background",
    );
    assert.equal(status.state, "background");
    assert.equal(status.phase, "stable");
    assert.deepEqual(events.slice(0, 6), [
      "inspect",
      "inspect",
      "install",
      "inspect",
      "start",
      "inspect",
    ]);
    assert.equal(events.includes("health"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returning Core to on-demand stops and removes its registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-service-ondemand-"));
  const context = setup(root);
  const events: string[] = [];
  const adapter = fakeAdapter(events);
  const options = {
    layout: context.layout,
    serviceStateDirectory: context.stateDirectory,
    definition: context.services.core,
    adapter,
    availability: { productInstalled: true, componentCreated: true },
    verifyHealth: async () => undefined,
  };
  try {
    await setManagedServiceMode(options, "background");
    events.length = 0;
    const status = await setManagedServiceMode(options, "on-demand");
    assert.equal(status.state, "on-demand");
    assert.equal(adapter.registered, false);
    assert.equal(adapter.running, false);
    assert.equal(events.includes("stop"), true);
    assert.equal(events.includes("remove"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed Background start compensates to the old mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-service-failure-"));
  const context = setup(root);
  const events: string[] = [];
  const adapter = fakeAdapter(events);
  adapter.start = async () => {
    events.push("start-failed");
    throw new Error("platform start failed");
  };
  try {
    await assert.rejects(
      setManagedServiceMode(
        {
          layout: context.layout,
          serviceStateDirectory: context.stateDirectory,
          definition: context.services.core,
          adapter,
          availability: { productInstalled: true, componentCreated: true },
          verifyHealth: async () => undefined,
        },
        "background",
      ),
      /could not set Cinba Core to background/,
    );
    assert.equal(adapter.registered, false);
    const state = await readServiceState(context.stateDirectory);
    assert.equal(state?.core.mode, "on-demand");
    assert.equal(state?.core.desiredMode, "background");
    assert.equal(state?.core.phase, "failed");
    assert.equal(state?.core.failure, "start-failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Core cannot be disabled and uncreated Sync cannot be configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-service-boundary-"));
  const context = setup(root);
  const adapter = fakeAdapter([]);
  try {
    await assert.rejects(
      setManagedServiceMode(
        {
          layout: context.layout,
          serviceStateDirectory: context.stateDirectory,
          definition: context.services.core,
          adapter,
          availability: { productInstalled: true, componentCreated: true },
        },
        "disabled",
      ),
      /does not support disabled/,
    );
    await assert.rejects(
      setManagedServiceMode(
        {
          layout: context.layout,
          serviceStateDirectory: context.stateDirectory,
          definition: context.services.sync,
          adapter,
          availability: { productInstalled: true, componentCreated: false },
        },
        "background",
      ),
      /has not been created/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
