import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { formatCoreStatus, isDirectExecution, parseCinbaCommand, runCoreCommand } from "./cinba.ts";

test("the npm junction path is recognized as direct command execution", () => {
  const paths = new Map([
    [resolve("repository/scripts/cinba.ts"), "/real/repository/scripts/cinba.ts"],
    [resolve("npm/node_modules/cinba/scripts/cinba.ts"), "/real/repository/scripts/cinba.ts"],
  ]);

  assert.equal(
    isDirectExecution(
      resolve("repository/scripts/cinba.ts"),
      resolve("npm/node_modules/cinba/scripts/cinba.ts"),
      (path) => paths.get(path) ?? path,
    ),
    true,
  );
});

test("TUI commands resolve the platform default, explicit mode, and project shorthand", () => {
  assert.deepEqual(parseCinbaCommand([], "example"), {
    type: "tui",
    workingDirectory: resolve("example"),
  });
  assert.deepEqual(parseCinbaCommand(["tui"], "example"), {
    type: "tui",
    workingDirectory: resolve("example"),
  });
  assert.deepEqual(parseCinbaCommand(["tui", "other"], "example"), {
    type: "tui",
    workingDirectory: resolve("other"),
  });
  assert.deepEqual(parseCinbaCommand(["other"], "example"), {
    type: "tui",
    workingDirectory: resolve("other"),
  });
});

test("Core subcommands are parsed independently of TUI commands", () => {
  assert.deepEqual(parseCinbaCommand(["core", "status"], "example"), {
    type: "core",
    action: "status",
  });
  assert.deepEqual(parseCinbaCommand(["core", "start"], "example"), {
    type: "core",
    action: "start",
  });
  assert.deepEqual(parseCinbaCommand(["core", "stop"], "example"), {
    type: "core",
    action: "stop",
  });
  assert.throws(() => parseCinbaCommand(["core"], "example"), {
    message: "usage: cinba [tui] [project] | cinba core <status|start|stop>",
  });
  assert.throws(() => parseCinbaCommand(["tui", "one", "two"], "example"), {
    message: "usage: cinba [tui] [project] | cinba core <status|start|stop>",
  });
});

test("Core status is concise but includes management details when available", () => {
  assert.equal(
    formatCoreStatus({ state: "stopped", running: false, managed: false }),
    "Cinba Core: stopped",
  );
  assert.equal(
    formatCoreStatus({
      state: "running",
      running: true,
      managed: true,
      pid: 123,
      lifetime: "on-demand",
      clientCount: 2,
      safeToStop: false,
    }),
    [
      "Cinba Core: running",
      "  PID: 123",
      "  Lifecycle: on-demand",
      "  Clients: 2",
      "  Safe to stop: no",
    ].join("\n"),
  );
});

test("Core commands delegate to the matching manager operation", async () => {
  const called: string[] = [];
  const stopped = { state: "stopped", running: false, managed: false } as const;
  const manager = {
    inspect: async () => {
      called.push("inspect");
      return stopped;
    },
    ensure: async () => {
      called.push("ensure");
      return stopped;
    },
    stop: async () => {
      called.push("stop");
      return stopped;
    },
  };

  await runCoreCommand("status", manager);
  await runCoreCommand("start", manager);
  await runCoreCommand("stop", manager);
  assert.deepEqual(called, ["inspect", "ensure", "stop"]);
});
