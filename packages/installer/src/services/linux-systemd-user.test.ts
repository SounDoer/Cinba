import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveProductPaths } from "../paths.ts";
import { createManagedServiceDefinitions } from "./definitions.ts";
import {
  type RunServiceCommand,
  createLinuxSystemdUserAdapter,
  enableLinuxLinger,
  inspectLinuxBackgroundSupport,
  renderSystemdUserUnit,
} from "./linux-systemd-user.ts";

const paths = resolveProductPaths({ platform: "linux", homeDirectory: "/home/cinba" });
const core = createManagedServiceDefinitions(paths, "linux").core;

test("systemd units execute the stable launcher with a per-user hardening baseline", () => {
  const unit = renderSystemdUserUnit(core);
  assert.match(unit, /ExecStart="\/home\/cinba\/\.local\/bin\/cinba" "service" "core"/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(unit, /UMask=0077/);
  assert.doesNotMatch(unit, /releases/);
});

test("Linux Background reports linger as an explicit authorization prerequisite", async () => {
  const commands: string[][] = [];
  const runCommand: RunServiceCommand = async (command, arguments_) => {
    commands.push([command, ...arguments_]);
    return {
      exitCode: 0,
      stdout: command === "loginctl" ? "no\n" : "",
      stderr: "",
    };
  };
  assert.deepEqual(await inspectLinuxBackgroundSupport({ userName: "cinba", runCommand }), {
    systemdUser: true,
    linger: false,
    authorizationRequired: true,
  });
  await enableLinuxLinger({
    userName: "cinba",
    authorization: { kind: "explicit-background-consent" },
    runCommand,
  });
  assert.deepEqual(commands.at(-1), ["loginctl", "enable-linger", "cinba"]);
});

test("the adapter installs, enables, starts, stops, and removes one user unit", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-systemd-user-"));
  const commands: string[][] = [];
  let registered = false;
  let running = false;
  const runCommand: RunServiceCommand = async (command, arguments_) => {
    commands.push([command, ...arguments_]);
    if (command === "loginctl") {
      return { exitCode: 0, stdout: "yes\n", stderr: "" };
    }
    if (arguments_.includes("enable")) {
      registered = true;
    }
    if (arguments_.includes("disable")) {
      registered = false;
    }
    if (arguments_.includes("start")) {
      running = true;
    }
    if (arguments_.includes("stop")) {
      running = false;
    }
    if (arguments_.includes("--property=LoadState")) {
      return { exitCode: 0, stdout: registered ? "loaded\n" : "not-found\n", stderr: "" };
    }
    if (arguments_.includes("--property=ActiveState")) {
      return { exitCode: 0, stdout: running ? "active\n" : "inactive\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const adapter = createLinuxSystemdUserAdapter({
    userName: "cinba",
    userUnitDirectory: join(root, "systemd", "user"),
    runCommand,
  });
  try {
    await adapter.install(core);
    assert.match(
      await readFile(join(root, "systemd", "user", "cinba-core.service"), "utf8"),
      /Cinba Core/,
    );
    await adapter.start(core);
    assert.deepEqual(await adapter.inspect(core), { registered: true, running: true });
    await adapter.stop(core);
    await adapter.remove(core);
    assert.deepEqual(await adapter.inspect(core), { registered: false, running: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
