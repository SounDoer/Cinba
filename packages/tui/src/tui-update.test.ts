import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { resolve } from "node:path";
import test from "node:test";
import { InteractionOwner } from "./interaction-owner.ts";
import {
  TUI_HANDOFF_TIMEOUT_MS,
  TUI_READINESS_TIMEOUT_MS,
  TuiUpdateHandoffController,
  TuiUpdateHandoffTimeoutError,
  blockTuiCoreInteractionDuringHandoff,
  checkTuiUpdateReadiness,
  createTuiInstallReadyUpdate,
  createTuiReadinessPrompt,
  createTuiUpdateConfirmation,
  denyTuiPermissionDuringHandoff,
  denyTuiProjectTrustDuringHandoff,
  launchTuiUpdateHandoff,
} from "./tui-update.ts";

type FakeChild = EventEmitter & {
  stdout: EventEmitter & { destroy: () => void };
  stderr: EventEmitter & { destroy: () => void };
  kill: (signal?: NodeJS.Signals) => boolean;
  unref: () => void;
};

function fakeChild(onKill: (signal?: NodeJS.Signals) => boolean = () => true): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Object.assign(new EventEmitter(), { destroy: () => {} });
  child.stderr = Object.assign(new EventEmitter(), { destroy: () => {} });
  child.kill = onKill;
  child.unref = () => {};
  return child;
}

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
  const handoffController = new TuiUpdateHandoffController();
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
    checkReadiness: async (executable: string, version: string) => {
      calls.push(["check", executable, version]);
      return { status: "ready" as const };
    },
    promptReadiness: async (confirmation, _signal) => {
      calls.push(["readiness", confirmation]);
      return false;
    },
    ownReadinessWait: (_cancel) => () => true,
    handoffController,
    stopObserver: () => calls.push("stop-observer"),
    restartObserver: () => calls.push("restart-observer"),
    launch: async (executable, arguments_, _signal) => {
      calls.push(["spawn", executable, arguments_]);
    },
    exit: () => calls.push("exit"),
    showNotice: (message) => calls.push(["notice", message]),
    ...overrides,
  });
  return { calls, handoffController, install, state };
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
    ["check", launcher.path, "0.2.0"],
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
    "Cinba update candidate changed from 0.2.0; no update was installed.",
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

test("remote permission during handoff is denied without replacing a dialog before successful exit", async () => {
  let complete!: () => void;
  const launched = new Promise<void>((resolveLaunch) => {
    complete = resolveLaunch;
  });
  const { calls, handoffController, install } = fixture({
    launch: async () => await launched,
  });

  const pending = install();
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  assert.equal(handoffController.inProgress, true);

  const responses: unknown[] = [];
  const handled = denyTuiPermissionDuringHandoff(
    handoffController,
    "confirm-1",
    (requestId, confirmed) => responses.push([requestId, confirmed]),
    (message) => calls.push(["notice", message]),
  );
  assert.equal(handled, true);
  assert.deepEqual(responses, [["confirm-1", false]]);
  assert.equal(
    calls.some((call) => Array.isArray(call) && call[0] === "dialog"),
    false,
  );

  complete();
  await pending;
  assert.equal(handoffController.inProgress, false);
  assert.equal(calls.at(-1), "exit");
});

test("remote project trust during handoff is denied while the handoff continues", async () => {
  let complete!: () => void;
  const launched = new Promise<void>((resolveLaunch) => {
    complete = resolveLaunch;
  });
  const { calls, handoffController, install } = fixture({
    launch: async () => await launched,
  });

  const pending = install();
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  const responses: unknown[] = [];
  assert.equal(
    denyTuiProjectTrustDuringHandoff(
      handoffController,
      "trust-1",
      (requestId, trusted) => responses.push([requestId, trusted]),
      (message) => calls.push(["notice", message]),
    ),
    true,
  );

  assert.deepEqual(responses, [["trust-1", false]]);
  assert.equal(handoffController.inProgress, true);
  complete();
  await pending;
  assert.equal(calls.at(-1), "exit");
});

test("handoff freezes Core-changing local interactions with one quiet notice", () => {
  const handoffController = new TuiUpdateHandoffController();
  const handoff = handoffController.begin();
  const calls: string[] = [];
  const invoke = (name: string): void => {
    if (
      !blockTuiCoreInteractionDuringHandoff(handoffController, (message) =>
        calls.push(`notice:${message}`),
      )
    ) {
      calls.push(name);
    }
  };

  for (const interaction of [
    "default",
    "followup",
    "slash",
    "ctrl+o",
    "ctrl+p",
    "shift+tab",
    "escape",
  ]) {
    invoke(interaction);
  }

  assert.equal(calls.length, 1);
  assert.match(calls[0] ?? "", /Preparing update handoff/);
  handoff.finish();
  invoke("default");
  assert.equal(calls.at(-1), "default");
});

test("handoff failure clears its flag and later permissions use the normal dialog path", async () => {
  const { handoffController, install } = fixture({
    launch: async () => {
      throw new Error("claim failed");
    },
  });

  await install();

  assert.equal(handoffController.inProgress, false);
  let responded = false;
  assert.equal(
    denyTuiPermissionDuringHandoff(
      handoffController,
      "confirm-2",
      () => {
        responded = true;
      },
      () => {},
    ),
    false,
  );
  assert.equal(responded, false);
});

test("observer stop failure also clears the handoff flag", async () => {
  const { calls, handoffController, install } = fixture({
    stopObserver: () => {
      throw new Error("observer stop failed");
    },
  });

  await install();

  assert.equal(handoffController.inProgress, false);
  assert.equal(calls.includes("restart-observer"), true);
  assert.equal(
    calls.some(
      (call) =>
        Array.isArray(call) &&
        call[0] === "notice" &&
        String(call[1]).includes("observer stop failed"),
    ),
    true,
  );
});

test("Ctrl+C abort clears handoff state without printing a false failure", async () => {
  const controller = new AbortController();
  const { calls, handoffController, install } = fixture({
    signal: controller.signal,
    launch: async (_executable: string, _arguments: readonly string[], signal: AbortSignal) =>
      await new Promise<void>((_resolveLaunch, rejectLaunch) => {
        signal.addEventListener("abort", () => rejectLaunch(new Error("cancelled")), {
          once: true,
        });
      }),
  });

  const pending = install();
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  controller.abort();
  await pending;

  assert.equal(handoffController.inProgress, false);
  assert.equal(calls.includes("restart-observer"), false);
  assert.equal(
    calls.some((call) => Array.isArray(call) && call[0] === "notice"),
    false,
  );
});

test("handoff timeout exits fail-safe without resuming Core work", async () => {
  const { calls, handoffController, install } = fixture({
    launch: async () => {
      throw new TuiUpdateHandoffTimeoutError("Cinba update handoff timed out after 5ms");
    },
  });

  await install();

  assert.equal(handoffController.inProgress, false);
  assert.equal(calls.includes("restart-observer"), false);
  assert.equal(calls.includes("exit"), true);
  assert.equal(
    calls.some(
      (call) =>
        Array.isArray(call) && call[0] === "notice" && /restart Cinba/i.test(String(call[1])),
    ),
    true,
  );
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

test("readiness prompt uses the strict reason and defaults Escape to Later", () => {
  assert.deepEqual(createTuiReadinessPrompt("Wait for Core to finish."), {
    title: "Update Waiting",
    message: "Wait for Core to finish.",
    positive: "Check Again",
    negative: "Later",
    defaultConfirmed: false,
  });
});

test("waiting then Later preserves observation, update state, and the TUI", async () => {
  const { calls, install, state } = fixture({
    checkReadiness: async (executable: string, version: string) => {
      calls.push(["check", executable, version]);
      return {
        status: "waiting",
        reasonCode: "core-active-work",
        message: "Wait for the active Core turn to finish.",
      };
    },
  });

  await install();

  assert.deepEqual(state.update, ready());
  assert.deepEqual(calls, [
    ["confirm", createTuiUpdateConfirmation("0.2.0", project)],
    ["check", launcher.path, "0.2.0"],
    ["readiness", createTuiReadinessPrompt("Wait for the active Core turn to finish.")],
  ]);
});

test("waiting then Check Again retries the same confirmed version until ready", async () => {
  let checks = 0;
  const { calls, install } = fixture({
    checkReadiness: async (executable: string, version: string) => {
      calls.push(["check", executable, version]);
      checks += 1;
      return checks === 1
        ? {
            status: "waiting",
            reasonCode: "sync-active-requests",
            message: "Wait for Sync requests to finish.",
          }
        : { status: "ready" };
    },
    promptReadiness: async (confirmation: ReturnType<typeof createTuiReadinessPrompt>) => {
      calls.push(["readiness", confirmation]);
      return true;
    },
  });

  await install();

  assert.deepEqual(
    calls.filter((call) => Array.isArray(call) && call[0] === "check"),
    [
      ["check", launcher.path, "0.2.0"],
      ["check", launcher.path, "0.2.0"],
    ],
  );
  assert.equal(calls.includes("stop-observer"), true);
  assert.equal(calls.at(-1), "exit");
});

test("multiple waiting checks leave observation and handoff untouched", async () => {
  let prompts = 0;
  const { calls, install } = fixture({
    checkReadiness: async () => ({
      status: "waiting",
      reasonCode: "external-sync",
      message: "Sync is managed externally.",
    }),
    promptReadiness: async () => {
      prompts += 1;
      return prompts < 3;
    },
  });

  await install();

  assert.equal(prompts, 3);
  assert.equal(calls.includes("stop-observer"), false);
  assert.equal(calls.includes("exit"), false);
});

test("a Core dialog cancels a readiness check and releases in-flight state", async () => {
  const owner = new InteractionOwner();
  let checks = 0;
  let coreCancelled = false;
  let waitingSignal: AbortSignal | undefined;
  const { install } = fixture({
    checkReadiness: async (_executable: string, _version: string, signal: AbortSignal) => {
      checks += 1;
      if (checks > 1) {
        return { status: "ready" };
      }
      waitingSignal = signal;
      await new Promise<void>((resolveWait) =>
        signal.addEventListener("abort", () => resolveWait(), { once: true }),
      );
      throw new Error("cancelled");
    },
    ownReadinessWait: (cancel: () => void) => owner.replace(cancel),
  });

  const first = install();
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  const releaseCore = owner.replace(() => {
    coreCancelled = true;
  });
  await first;

  assert.equal(waitingSignal?.aborted, true);
  assert.equal(coreCancelled, false);
  releaseCore();
  await install();
  assert.equal(checks, 2);
});

test("candidate mismatch after waiting never checks or installs another version", async () => {
  let update = ready("0.2.0");
  const { calls, install } = fixture({
    getUpdate: () => update,
    checkReadiness: async (executable: string, version: string) => {
      calls.push(["check", executable, version]);
      return {
        status: "waiting",
        reasonCode: "core-active-work",
        message: "Core is busy.",
      };
    },
    promptReadiness: async () => {
      update = ready("0.3.0");
      return true;
    },
  });

  await install();

  assert.deepEqual(
    calls.filter((call) => Array.isArray(call) && call[0] === "check"),
    [["check", launcher.path, "0.2.0"]],
  );
  assert.equal(calls.includes("stop-observer"), false);
  assert.equal(
    calls.some(
      (call) =>
        Array.isArray(call) &&
        call[0] === "notice" &&
        String(call[1]).includes("changed from 0.2.0"),
    ),
    true,
  );
});

test("readiness failures restore the prompt, show a bounded notice, and permit retry", async () => {
  let checks = 0;
  const { calls, install } = fixture({
    checkReadiness: async () => {
      checks += 1;
      if (checks === 1) {
        throw new Error(`invalid readiness ${"x".repeat(3_000)}`);
      }
      return { status: "ready" };
    },
  });

  await install();
  assert.equal(calls.includes("exit"), false);
  const notice = calls.find(
    (call) => Array.isArray(call) && call[0] === "notice" && call[1].includes("invalid readiness"),
  ) as [string, string];
  assert.ok(notice[1].length <= 2_048);

  await install();
  assert.equal(checks, 2);
  assert.equal(calls.at(-1), "exit");
});

test("readiness runner uses argv without a shell and strict shared JSON parsing", async () => {
  const child = fakeChild();
  let received: unknown;
  const pending = checkTuiUpdateReadiness("C:\\Users\\A\\bin\\cinba.exe", "0.2.0", {}, ((
    executable: string,
    arguments_: readonly string[],
    options: unknown,
  ) => {
    received = [executable, arguments_, options];
    return child;
  }) as never);
  assert.deepEqual(received, [
    "C:\\Users\\A\\bin\\cinba.exe",
    ["__check-update-readiness", "0.2.0"],
    { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  ]);
  child.stdout.emit("data", '{"status":"ready"}\n');
  child.emit("close", 0, null);
  assert.deepEqual(await pending, { status: "ready" });
});

test("readiness runner rejects invalid, multiple, oversized, and error output", async () => {
  async function rejected(stdout: string, stderr: string, code: number): Promise<Error> {
    const child = fakeChild();
    const pending = checkTuiUpdateReadiness("cinba", "0.2.0", {}, (() => child) as never);
    child.stdout.emit("data", stdout);
    child.stderr.emit("data", stderr);
    child.emit("close", code, null);
    try {
      await pending;
    } catch (error) {
      assert.ok(error instanceof Error);
      return error;
    }
    assert.fail("expected readiness check to reject");
  }

  for (const [stdout, stderr, code] of [
    ['{"status":"ready"}\n', `failed ${"x".repeat(3_000)}`, 9],
    ["not json\n", "", 0],
    ['{"status":"ready"}\n{"status":"ready"}\n', "", 0],
    [`${"x".repeat(10_000)}\n`, "", 0],
  ] as const) {
    const error = await rejected(stdout, stderr, code);
    assert.ok(error.message.length <= 2_048);
  }
});

test("readiness timeout and abort kill children, clean listeners, and settle once", async () => {
  let timeoutKills = 0;
  const timedOutChild = fakeChild(() => {
    timeoutKills += 1;
    setImmediate(() => timedOutChild.emit("close", null, "SIGTERM"));
    return true;
  });
  await assert.rejects(
    checkTuiUpdateReadiness(
      "cinba",
      "0.2.0",
      { timeoutMilliseconds: 5 },
      (() => timedOutChild) as never,
    ),
    /timed out after 5ms/,
  );
  assert.equal(timeoutKills, 1);

  const controller = new AbortController();
  let abortKills = 0;
  const abortedChild = fakeChild(() => {
    abortKills += 1;
    setImmediate(() => abortedChild.emit("close", null, "SIGTERM"));
    return true;
  });
  const aborted = checkTuiUpdateReadiness(
    "cinba",
    "0.2.0",
    { signal: controller.signal },
    (() => abortedChild) as never,
  );
  controller.abort();
  abortedChild.emit("error", new Error("kill race"));
  await assert.rejects(aborted, /cancelled/);
  assert.equal(abortKills, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("readiness close and abort race does not kill a completed child", async () => {
  const controller = new AbortController();
  let killed = 0;
  const child = fakeChild(() => {
    killed += 1;
    return true;
  });
  const pending = checkTuiUpdateReadiness(
    "cinba",
    "0.2.0",
    { signal: controller.signal },
    (() => child) as never,
  );
  child.stdout.emit("data", '{"status":"ready"}\n');
  child.emit("close", 0, null);
  controller.abort();
  assert.deepEqual(await pending, { status: "ready" });
  assert.equal(killed, 0);
});

test("readiness and handoff expose explicit timeouts", () => {
  assert.equal(TUI_READINESS_TIMEOUT_MS, 10_000);
  assert.equal(TUI_HANDOFF_TIMEOUT_MS, 60_000);
});

test("handoff client uses no shell, captures bounded stderr, and requires exit zero", async () => {
  const child = fakeChild();
  let received: unknown;
  const launched = launchTuiUpdateHandoff(
    launcher.path,
    ["__begin-update-handoff", "tui", "123", "0.2.0", project],
    {},
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
  child.emit("close", 9, null);
  await assert.rejects(
    launched,
    (error: Error) => error.message.includes("code 9") && error.message.length <= 2_048,
  );

  const succeeded = fakeChild();
  const success = launchTuiUpdateHandoff(launcher.path, [], {}, (() => succeeded) as never);
  succeeded.emit("close", 0, null);
  await success;
});

test("handoff timeout kills the child and waits for settlement", async () => {
  let killed = 0;
  const child = fakeChild(() => {
    killed += 1;
    setImmediate(() => child.emit("close", null, "SIGTERM"));
    return true;
  });
  const pending = launchTuiUpdateHandoff(
    "cinba",
    ["__begin-update-handoff", "tui", "123", "0.2.0", project],
    { timeoutMilliseconds: 5 },
    (() => child) as never,
  );
  await assert.rejects(pending, /timed out after 5ms/);
  assert.equal(killed, 1);
});

test("an ignored TERM escalates to KILL and settles without close", async () => {
  const signals: (NodeJS.Signals | undefined)[] = [];
  let stdoutDestroyed = 0;
  let stderrDestroyed = 0;
  let unrefed = 0;
  const child = fakeChild((signal) => {
    signals.push(signal);
    return true;
  });
  child.stdout.destroy = () => {
    stdoutDestroyed += 1;
  };
  child.stderr.destroy = () => {
    stderrDestroyed += 1;
  };
  child.unref = () => {
    unrefed += 1;
  };

  const pending = checkTuiUpdateReadiness(
    "cinba",
    "0.2.0",
    { timeoutMilliseconds: 5, terminationGraceMilliseconds: 5 },
    (() => child) as never,
  );

  await assert.rejects(pending, /timed out after 5ms/);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(stdoutDestroyed, 1);
  assert.equal(stderrDestroyed, 1);
  assert.equal(unrefed, 1);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.listenerCount("error"), 0);
  child.emit("close", null, "SIGKILL");
});

test("kill false and kill throw both settle termination without close", async () => {
  for (const outcome of ["false", "throw"] as const) {
    const signals: (NodeJS.Signals | undefined)[] = [];
    const child = fakeChild((signal) => {
      signals.push(signal);
      if (outcome === "throw") {
        throw new Error("kill failed");
      }
      return false;
    });
    const pending = checkTuiUpdateReadiness(
      "cinba",
      "0.2.0",
      { timeoutMilliseconds: 5, terminationGraceMilliseconds: 5 },
      (() => child) as never,
    );

    await assert.rejects(pending, /timed out after 5ms/);
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  }
});

test("Ctrl+C abort settles after grace when the child never closes", async () => {
  const controller = new AbortController();
  const signals: (NodeJS.Signals | undefined)[] = [];
  const child = fakeChild((signal) => {
    signals.push(signal);
    return true;
  });
  const pending = launchTuiUpdateHandoff(
    "cinba",
    ["__begin-update-handoff", "tui", "123", "0.2.0", project],
    {
      signal: controller.signal,
      terminationGraceMilliseconds: 5,
    },
    (() => child) as never,
  );

  controller.abort();

  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
