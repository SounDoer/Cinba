import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import test from "node:test";
import { InteractionOwner } from "./interaction-owner.ts";
import {
  createTuiInstallReadyUpdate,
  createTuiUpdateConfirmation,
  launchTuiUpdateHandoff,
} from "./tui-update.ts";

const launcher = {
  path: resolve("bin", "cinba.exe"),
  processId: 123,
};
const project = resolve("project");

function ready(version = "0.2.0") {
  return { phase: "ready" as const, candidateVersion: version };
}

function fixture(overrides: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  const state = {
    update: ready() as ReturnType<typeof ready> | { phase: "idle" } | { phase: "checking" },
    busy: false,
    compacting: false,
  };
  const install = createTuiInstallReadyUpdate({
    launcher,
    workingDirectory: project,
    getUpdate: () => state.update,
    isBusy: () => state.busy,
    isCompacting: () => state.compacting,
    confirm: async (confirmation) => {
      calls.push(["confirm", confirmation]);
      return true;
    },
    stopObserver: () => calls.push("stop-observer"),
    restartObserver: () => calls.push("restart-observer"),
    launch: async (executable, arguments_) => {
      calls.push(["spawn", executable, arguments_]);
    },
    exit: () => calls.push("exit"),
    showNotice: (message) => calls.push(["notice", message]),
    ...overrides,
  });
  return { calls, install, state };
}

test("TUI confirmation explains restart and defaults Escape to Later", () => {
  assert.deepEqual(createTuiUpdateConfirmation("0.2.0", project), {
    title: "Install Cinba 0.2.0",
    message: `Cinba TUI and this computer's Core and Sync will stop safely. After the update, Cinba TUI will reopen in ${project}.`,
    positive: "Install and Restart",
    negative: "Later",
    defaultConfirmed: false,
  });
});

test("development, non-ready, and busy TUI update requests show clear notices", async () => {
  const development = fixture({ launcher: undefined });
  await development.install();
  assert.deepEqual(development.calls, [
    ["notice", "Updates can be installed here only from an installed Cinba TUI."],
  ]);

  const nonReady = fixture();
  nonReady.state.update = { phase: "checking" };
  await nonReady.install();
  assert.deepEqual(nonReady.calls, [["notice", "No ready Cinba update is available."]]);

  for (const activity of ["busy", "compacting"] as const) {
    const active = fixture();
    active.state[activity] = true;
    await active.install();
    assert.deepEqual(active.calls, [
      [
        "notice",
        "Wait for the current answer or context compaction to finish before installing the update.",
      ],
    ]);
  }
});

test("choosing Later leaves update state and observation untouched", async () => {
  const { calls, install, state } = fixture({
    confirm: async () => false,
  });
  await install();
  assert.deepEqual(calls, []);
  assert.deepEqual(state.update, ready());
});

test("confirmation launches the TUI handoff with top launcher PID and current project", async () => {
  const { calls, install } = fixture();
  await install();
  assert.deepEqual(calls, [
    ["confirm", createTuiUpdateConfirmation("0.2.0", project)],
    "stop-observer",
    [
      "spawn",
      launcher.path,
      ["__begin-update-handoff", "tui", String(launcher.processId), "0.2.0", project],
    ],
    "exit",
  ]);
});

test("TUI does not hand off when the ready candidate changes during confirmation", async () => {
  const { calls, install, state } = fixture({
    confirm: async () => {
      state.update = ready("0.3.0");
      return true;
    },
  });
  await install();
  assert.equal(
    calls.some((call) => Array.isArray(call) && call[0] === "spawn"),
    false,
  );
  assert.equal(calls.includes("stop-observer"), false);
  assert.deepEqual(calls.at(-1), [
    "notice",
    "The update is no longer ready to install. Please try /update again.",
  ]);
});

test("a Core permission dialog cancels update confirmation and releases in-flight state", async () => {
  const owner = new InteractionOwner();
  let answerUpdate: ((confirmed: boolean) => void) | undefined;
  let closeUpdate: (() => void) | undefined;
  let confirmations = 0;
  let coreCancelled = false;
  const { calls, install } = fixture({
    confirm: async () =>
      await new Promise<boolean>((resolveAnswer) => {
        confirmations += 1;
        answerUpdate = resolveAnswer;
        closeUpdate = owner.replace(() => resolveAnswer(false));
      }),
  });

  const first = install();
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  const closeCore = owner.replace(() => {
    coreCancelled = true;
  });
  await first;
  assert.equal(coreCancelled, false);
  closeCore();

  const second = install();
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  closeUpdate?.();
  answerUpdate?.(false);
  await second;

  assert.equal(confirmations, 2);
  assert.equal(
    calls.some((call) => Array.isArray(call) && call[0] === "spawn"),
    false,
  );
});

test("replaced interactions cannot later reclaim the prompt", () => {
  const owner = new InteractionOwner();
  const releaseUpdate = owner.replace(() => {});
  const releaseCore = owner.replace(() => {});

  assert.equal(releaseUpdate(), false);
  assert.equal(releaseCore(), true);
});

test("TUI exits only after the begin helper exits successfully", async () => {
  let complete!: () => void;
  const launched = new Promise<void>((resolveLaunch) => {
    complete = resolveLaunch;
  });
  const { calls, install } = fixture({ launch: async () => await launched });
  const pending = install();
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  assert.equal(calls.includes("exit"), false);
  complete();
  await pending;
  assert.equal(calls.at(-1), "exit");
});

test("begin failure restores observation, keeps TUI open, bounds the error, and permits retry", async () => {
  let attempts = 0;
  const { calls, install } = fixture({
    launch: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error(`claim failed ${"x".repeat(3_000)}`);
      }
    },
  });
  await install();
  assert.equal(calls.includes("exit"), false);
  assert.equal(calls.includes("restart-observer"), true);
  const notice = calls.find(
    (call) => Array.isArray(call) && call[0] === "notice" && call[1].includes("claim failed"),
  ) as [string, string];
  assert.ok(notice[1].length <= 2_048);

  await install();
  assert.equal(attempts, 2);
  assert.equal(calls.at(-1), "exit");
});

test("concurrent confirmations share one handoff", async () => {
  let confirmations = 0;
  let complete!: () => void;
  const launched = new Promise<void>((resolveLaunch) => {
    complete = resolveLaunch;
  });
  const { calls, install } = fixture({
    confirm: async () => {
      confirmations += 1;
      return true;
    },
    launch: async () => await launched,
  });
  const first = install();
  const second = install();
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  assert.equal(confirmations, 1);
  complete();
  await Promise.all([first, second]);
  assert.equal(calls.filter((call) => call === "exit").length, 1);
});

test("handoff client uses no shell, captures bounded stderr, and requires exit zero", async () => {
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  child.stderr = new EventEmitter();
  let received: unknown;
  const launched = launchTuiUpdateHandoff(
    launcher.path,
    ["__begin-update-handoff", "tui", "123", "0.2.0", project],
    ((executable: string, arguments_: readonly string[], options: unknown) => {
      received = [executable, arguments_, options];
      return child;
    }) as never,
  );
  assert.deepEqual(received, [
    launcher.path,
    ["__begin-update-handoff", "tui", "123", "0.2.0", project],
    { shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  ]);
  child.stderr.emit("data", Buffer.from("x".repeat(3_000)));
  child.emit("exit", 9, null);
  await assert.rejects(
    launched,
    (error: Error) => error.message.includes("code 9") && error.message.length <= 2_048,
  );

  const succeeded = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  succeeded.stderr = new EventEmitter();
  const success = launchTuiUpdateHandoff(launcher.path, [], (() => succeeded) as never);
  succeeded.emit("exit", 0, null);
  await success;
});
