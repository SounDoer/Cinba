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
    unavailableReason: null,
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

function missingSystemctl(): RunServiceCommand {
  return async (command) => {
    throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
  };
}

test("a host without systemd reports Background unavailable instead of failing", async () => {
  const adapter = createLinuxSystemdUserAdapter({
    userName: "cinba",
    userUnitDirectory: "/home/cinba/.config/systemd/user",
    runCommand: missingSystemctl(),
  });
  const snapshot = await adapter.inspect(core);
  assert.equal(snapshot.registered, false);
  assert.equal(snapshot.running, false);
  assert.match(snapshot.backgroundUnavailable ?? "", /does not run systemd/);
  await assert.rejects(adapter.prepareBackground?.(core) ?? Promise.resolve(), (error: Error) => {
    assert.equal(error.name, "LinuxBackgroundUnavailableError");
    assert.match(error.message, /Background is unavailable because this host does not run systemd/);
    assert.match(error.message, /stays on-demand/);
    return true;
  });
  await assert.rejects(adapter.install(core), { name: "LinuxBackgroundUnavailableError" });
});

test("a missing user manager names the systemd error", async () => {
  const support = await inspectLinuxBackgroundSupport({
    userName: "cinba",
    runCommand: async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Failed to connect to bus: No medium found\n",
    }),
  });
  assert.equal(support.systemdUser, false);
  assert.equal(
    support.unavailableReason,
    "the systemd user manager is not running for this user (Failed to connect to bus: No medium found)",
  );
});

function systemdWithoutLinger(commands: string[][]): RunServiceCommand {
  let linger = false;
  return async (command, arguments_) => {
    commands.push([command, ...arguments_]);
    if (command === "loginctl" && arguments_[0] === "enable-linger") {
      linger = true;
    }
    if (command === "loginctl" && arguments_[0] === "show-user") {
      return { exitCode: 0, stdout: linger ? "yes\n" : "no\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

test("Background without linger names the cause and the fix", async () => {
  const commands: string[][] = [];
  const adapter = createLinuxSystemdUserAdapter({
    userName: "cinba",
    userUnitDirectory: "/home/cinba/.config/systemd/user",
    runCommand: systemdWithoutLinger(commands),
  });
  for (const attempt of [adapter.prepareBackground?.(core), adapter.install(core)]) {
    await assert.rejects(attempt ?? Promise.resolve(), (error: Error) => {
      assert.equal(error.name, "LinuxLingerRequiredError");
      assert.match(error.message, /needs linger for user cinba/);
      assert.match(error.message, /sudo loginctl enable-linger cinba/);
      return true;
    });
  }
  assert.equal(
    commands.some(([command, action]) => command === "loginctl" && action === "enable-linger"),
    false,
  );
});

test("Background enables linger only after the user consents", async () => {
  const commands: string[][] = [];
  const runCommand = systemdWithoutLinger(commands);
  const declined = createLinuxSystemdUserAdapter({
    userName: "cinba",
    userUnitDirectory: "/home/cinba/.config/systemd/user",
    runCommand,
    runInteractiveCommand: runCommand,
    authorizeLinger: async () => false,
  });
  await assert.rejects(declined.prepareBackground?.(core) ?? Promise.resolve(), {
    name: "LinuxLingerRequiredError",
  });
  assert.equal(
    commands.some(([, action]) => action === "enable-linger"),
    false,
  );

  const asked: string[] = [];
  const accepted = createLinuxSystemdUserAdapter({
    userName: "cinba",
    userUnitDirectory: "/home/cinba/.config/systemd/user",
    runCommand,
    runInteractiveCommand: runCommand,
    authorizeLinger: async (userName) => {
      asked.push(userName);
      return true;
    },
  });
  await accepted.prepareBackground?.(core);
  assert.deepEqual(asked, ["cinba"]);
  assert.deepEqual(
    commands.filter(([, action]) => action === "enable-linger"),
    [["loginctl", "enable-linger", "cinba"]],
  );
});

test("a refused linger authorization keeps the fix in the error", async () => {
  const adapter = createLinuxSystemdUserAdapter({
    userName: "cinba",
    userUnitDirectory: "/home/cinba/.config/systemd/user",
    runCommand: systemdWithoutLinger([]),
    runInteractiveCommand: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    authorizeLinger: async () => true,
  });
  await assert.rejects(adapter.prepareBackground?.(core) ?? Promise.resolve(), (error: Error) => {
    assert.equal(error.name, "LinuxLingerRequiredError");
    assert.match(error.message, /not authorized/);
    assert.match(error.message, /sudo loginctl enable-linger cinba/);
    return true;
  });
});
