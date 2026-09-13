import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  formatCoreStatus,
  isDirectExecution,
  parseCinbaCommand,
  runCoreCommand,
  tuiProcessArguments,
} from "./cinba.ts";

test("the global cinba command enters the shared TUI launcher in the current directory", () => {
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const project = join(repositoryRoot, "example project");

  assert.deepEqual(tuiProcessArguments(project), [
    process.execPath,
    join(repositoryRoot, "scripts", "launch.ts"),
    "tui",
    resolve(project),
  ]);
});

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

test("Core subcommands are parsed without changing the bare TUI command", () => {
  assert.deepEqual(parseCinbaCommand([], "example"), {
    type: "tui",
    workingDirectory: resolve("example"),
  });
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
  assert.throws(() => parseCinbaCommand(["status"], "example"), {
    message: "usage: cinba | cinba core <status|start|stop>",
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
