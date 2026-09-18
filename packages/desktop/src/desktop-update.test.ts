import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createDesktopInstallReadyUpdate,
  createDesktopUpdateConfirmation,
  launchDesktopUpdateHandoff,
} from "./desktop-update.ts";

function ready(version = "0.2.0") {
  return { phase: "ready" as const, candidateVersion: version };
}

function fixture(overrides: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  const options = {
    identity: "release" as const,
    launcherPath: "C:\\Users\\A\\bin\\cinba.exe",
    processId: 123,
    getUpdate: () => ready(),
    confirm: async () => true,
    abortAutomaticUpdate: () => calls.push("abort"),
    resumeAutomaticUpdate: () => calls.push("resume"),
    launch: async (executable: string, arguments_: readonly string[]) => {
      calls.push(["spawn", executable, arguments_]);
    },
    quit: () => calls.push("quit"),
    showError: async (message: string) => {
      calls.push(["error", message]);
    },
    ...overrides,
  };
  return { calls, install: createDesktopInstallReadyUpdate(options) };
}

test("Desktop install confirmation defaults and cancels to Later", () => {
  assert.deepEqual(createDesktopUpdateConfirmation("0.2.0"), {
    type: "info",
    title: "Install Cinba 0.2.0",
    message: "Cinba 0.2.0 is ready to install.",
    detail:
      "Cinba Desktop and this computer's Core and Sync will stop safely, then Cinba will restart.",
    buttons: ["Install and Restart", "Later"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
});

test("choosing Later does not stop observation, spawn, or quit", async () => {
  const { calls, install } = fixture({ confirm: async () => false });
  await install();
  assert.deepEqual(calls, []);
});

test("confirmed ready update launches the stable handoff command and quits", async () => {
  const { calls, install } = fixture();
  await install();
  assert.deepEqual(calls, [
    "abort",
    [
      "spawn",
      "C:\\Users\\A\\bin\\cinba.exe",
      ["__begin-update-handoff", "desktop", "123", "0.2.0"],
    ],
    "quit",
  ]);
});

test("Desktop does not hand off when the ready candidate changes during confirmation", async () => {
  let update = ready("0.2.0");
  const { calls, install } = fixture({
    getUpdate: () => update,
    confirm: async () => {
      update = ready("0.3.0");
      return true;
    },
  });
  await assert.rejects(install(), /ready update changed during confirmation/);
  assert.deepEqual(calls, []);
});

test("Desktop waits for the begin process before quitting", async () => {
  let complete!: () => void;
  const launch = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const { calls, install } = fixture({ launch: async () => await launch });
  const pending = install();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["abort"]);
  complete();
  await pending;
  assert.deepEqual(calls, ["abort", "quit"]);
});

test("handoff launch failure keeps Desktop running, resumes observation, and shows bounded error", async () => {
  const { calls, install } = fixture({
    launch: async () => {
      throw new Error(`claim failed ${"x".repeat(3_000)}`);
    },
  });
  await install();
  assert.equal(calls.includes("quit"), false);
  assert.equal(calls.includes("resume"), true);
  const error = calls.find((call) => Array.isArray(call) && call[0] === "error") as [
    string,
    string,
  ];
  assert.match(error[1], /^Cinba could not start the update: claim failed/);
  assert.ok(error[1].length <= 2_048);
});

test("concurrent install requests share one confirmation and handoff", async () => {
  let confirmations = 0;
  let complete!: () => void;
  const launch = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const { calls, install } = fixture({
    confirm: async () => {
      confirmations += 1;
      return true;
    },
    launch: async () => await launch,
  });
  const first = install();
  const second = install();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(confirmations, 1);
  complete();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ["abort", "quit"]);
});

test("a second request after handoff success cannot launch again while Desktop quits", async () => {
  const { calls, install } = fixture();
  await install();
  await install();
  assert.deepEqual(calls, [
    "abort",
    [
      "spawn",
      "C:\\Users\\A\\bin\\cinba.exe",
      ["__begin-update-handoff", "desktop", "123", "0.2.0"],
    ],
    "quit",
  ]);
});

test("development and non-ready Desktop requests fail closed", async () => {
  const development = fixture({ identity: "development" });
  await assert.rejects(development.install(), /release Desktop/);
  assert.deepEqual(development.calls, []);

  const checking = fixture({ getUpdate: () => ({ phase: "checking" }) });
  await assert.rejects(checking.install(), /ready update/);
  assert.deepEqual(checking.calls, []);
});

test("handoff launcher uses argv without a shell and resolves only on exit zero", async () => {
  const child = new EventEmitter();
  let received: unknown;
  const launched = launchDesktopUpdateHandoff(
    "C:\\Users\\A\\bin\\cinba.exe",
    ["__begin-update-handoff", "desktop", "123", "0.2.0"],
    ((executable: string, arguments_: readonly string[], options: unknown) => {
      received = [executable, arguments_, options];
      return child;
    }) as never,
  );
  assert.deepEqual(received, [
    "C:\\Users\\A\\bin\\cinba.exe",
    ["__begin-update-handoff", "desktop", "123", "0.2.0"],
    { shell: false, stdio: "ignore", windowsHide: true },
  ]);
  child.emit("exit", 0, null);
  await launched;
});

test("handoff launcher rejects process errors and non-zero exits", async () => {
  const failed = new EventEmitter();
  const spawnFailed = launchDesktopUpdateHandoff(
    "cinba",
    ["__begin-update-handoff", "desktop", "123", "0.2.0"],
    (() => failed) as never,
  );
  failed.emit("exit", 9, null);
  await assert.rejects(spawnFailed, /exited with code 9/);

  const errored = new EventEmitter();
  const spawnErrored = launchDesktopUpdateHandoff(
    "cinba",
    ["__begin-update-handoff", "desktop", "123", "0.2.0"],
    (() => errored) as never,
  );
  const original = new Error("spawn denied");
  errored.emit("error", original);
  await assert.rejects(spawnErrored, (error) => error === original);
});
