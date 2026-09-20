import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import type { InstallationLayout } from "../installation-store.ts";
import { resolveProductPaths } from "../paths.ts";
import { createManagedServiceDefinitions } from "./definitions.ts";
import {
  type PlatformServiceAdapter,
  inspectManagedService,
  setManagedServiceMode,
} from "./service-manager.ts";
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

test("Background commits only after registration, start, and health", async (t) => {
  const root = temporaryDirectory("cinba-service-background-", t);
  const context = setup(root);
  const events: string[] = [];
  const adapter = fakeAdapter(events);
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
});

test("returning Core to on-demand stops and removes its registration", async (t) => {
  const root = temporaryDirectory("cinba-service-ondemand-", t);
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
  await setManagedServiceMode(options, "background");
  events.length = 0;
  const status = await setManagedServiceMode(options, "on-demand");
  assert.equal(status.state, "on-demand");
  assert.equal(adapter.registered, false);
  assert.equal(adapter.running, false);
  assert.equal(events.includes("stop"), true);
  assert.equal(events.includes("remove"), true);
});

test("a failed Background start compensates to the old mode", async (t) => {
  const root = temporaryDirectory("cinba-service-failure-", t);
  const context = setup(root);
  const events: string[] = [];
  const adapter = fakeAdapter(events);
  adapter.start = async () => {
    events.push("start-failed");
    throw new Error("platform start failed");
  };
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
    /could not set Cinba Core to background: platform start failed/,
  );
  assert.equal(adapter.registered, false);
  const state = await readServiceState(context.stateDirectory);
  assert.equal(state?.core.mode, "on-demand");
  assert.equal(state?.core.desiredMode, "background");
  assert.equal(state?.core.phase, "failed");
  assert.equal(state?.core.failure, "start-failed");
});

test("a briefly running service is not committed when another process answers health", async (t) => {
  const root = temporaryDirectory("cinba-service-impostor-", t);
  const context = setup(root);
  const events: string[] = [];
  const adapter = fakeAdapter(events);
  let inspectsAfterStart = 0;
  adapter.inspect = async function () {
    events.push("inspect");
    // Like a Windows task that reaches Running, then exits because the port is taken.
    if (this.running) {
      inspectsAfterStart += 1;
      if (inspectsAfterStart > 1) {
        this.running = false;
      }
    }
    return { registered: this.registered, running: this.running };
  };
  let healthChecks = 0;
  await assert.rejects(
    setManagedServiceMode(
      {
        layout: context.layout,
        serviceStateDirectory: context.stateDirectory,
        definition: context.services.core,
        adapter,
        availability: { productInstalled: true, componentCreated: true },
        verifyHealth: async () => {
          healthChecks += 1;
          throw new Error("the Core answering health is not the Background service");
        },
      },
      "background",
    ),
    /could not set Cinba Core to background/,
  );
  assert.equal(healthChecks > 1, true);
  assert.equal(adapter.registered, false);
  const state = await readServiceState(context.stateDirectory);
  assert.equal(state?.core.mode, "on-demand");
  assert.equal(state?.core.phase, "failed");
  assert.equal(state?.core.failure, "health-failed");
});

test("Background waits for an asynchronously starting platform service", async (t) => {
  const root = temporaryDirectory("cinba-service-settle-", t);
  const context = setup(root);
  const adapter = fakeAdapter([]);
  let started = false;
  let inspectionsAfterStart = 0;
  let healthChecks = 0;
  adapter.start = async () => {
    started = true;
  };
  adapter.inspect = async () => {
    if (!started) {
      return { registered: adapter.registered, running: false };
    }
    inspectionsAfterStart += 1;
    return { registered: adapter.registered, running: inspectionsAfterStart >= 2 };
  };
  const status = await setManagedServiceMode(
    {
      layout: context.layout,
      serviceStateDirectory: context.stateDirectory,
      definition: context.services.core,
      adapter,
      availability: { productInstalled: true, componentCreated: true },
      verifyHealth: async () => {
        healthChecks += 1;
        if (healthChecks < 2) {
          throw new Error("service is still opening its health port");
        }
      },
    },
    "background",
  );
  assert.equal(status.state, "background");
  assert.equal(status.running, true);
  assert.equal(inspectionsAfterStart >= 2, true);
  assert.equal(healthChecks >= 2, true);
});

test("Core cannot be disabled and uncreated Sync cannot be configured", async (t) => {
  const root = temporaryDirectory("cinba-service-boundary-", t);
  const context = setup(root);
  const adapter = fakeAdapter([]);
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
});

test("an unavailable Background stays on-demand and refuses before recording an attempt", async (t) => {
  const root = temporaryDirectory("cinba-service-unavailable-", t);
  const context = setup(root);
  const events: string[] = [];
  const adapter = fakeAdapter(events);
  adapter.inspect = async () => {
    events.push("inspect");
    return { registered: false, running: false, backgroundUnavailable: "no service manager" };
  };
  adapter.prepareBackground = async () => {
    events.push("prepare");
    throw new Error("Background is unavailable because no service manager");
  };
  const options = {
    layout: context.layout,
    serviceStateDirectory: context.stateDirectory,
    definition: context.services.core,
    adapter,
    availability: { productInstalled: true, componentCreated: true },
    verifyHealth: async () => undefined,
  };
  const onDemand = await setManagedServiceMode(options, "on-demand");
  assert.equal(onDemand.state, "on-demand");
  assert.equal(
    "backgroundUnavailable" in onDemand && onDemand.backgroundUnavailable,
    "no service manager",
  );
  const before = await readServiceState(context.stateDirectory);
  await assert.rejects(setManagedServiceMode(options, "background"), {
    message: "Background is unavailable because no service manager",
  });
  assert.deepEqual(await readServiceState(context.stateDirectory), before);
  assert.equal(events.includes("install"), false);
  const status = await inspectManagedService(options);
  assert.equal(status.state, "on-demand");
  assert.equal("phase" in status && status.phase, "stable");
});
