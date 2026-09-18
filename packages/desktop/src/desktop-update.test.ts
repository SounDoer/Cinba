import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import test from "node:test";
import {
  DESKTOP_HANDOFF_TIMEOUT_MS,
  DESKTOP_READINESS_TIMEOUT_MS,
  checkDesktopUpdateReadiness,
  createDesktopInstallReadyUpdate,
  createDesktopReadinessPrompt,
  createDesktopUpdateConfirmation,
  launchDesktopUpdateHandoff,
} from "./desktop-update.ts";

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => boolean;
};

function fakeChild(onKill: () => void = () => {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    onKill();
    return true;
  };
  return child;
}

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
    checkReadiness: async (executable: string, version: string) => {
      calls.push(["check", executable, version]);
      return { status: "ready" as const };
    },
    promptReadiness: async (message: string, error: boolean) => {
      calls.push(["readiness", message, error]);
      return false;
    },
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
    ["check", "C:\\Users\\A\\bin\\cinba.exe", "0.2.0"],
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
  await install();
  assert.deepEqual(calls, [
    ["error", "Cinba update candidate changed from 0.2.0; no update was installed."],
  ]);
});

test("Desktop waits for the begin process before quitting", async () => {
  let complete!: () => void;
  const launch = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const { calls, install } = fixture({ launch: async () => await launch });
  const pending = install();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [["check", "C:\\Users\\A\\bin\\cinba.exe", "0.2.0"], "abort"]);
  complete();
  await pending;
  assert.deepEqual(calls, [["check", "C:\\Users\\A\\bin\\cinba.exe", "0.2.0"], "abort", "quit"]);
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
  assert.deepEqual(calls, [["check", "C:\\Users\\A\\bin\\cinba.exe", "0.2.0"], "abort", "quit"]);
});

test("a second request after handoff success cannot launch again while Desktop quits", async () => {
  const { calls, install } = fixture();
  await install();
  await install();
  assert.deepEqual(calls, [
    ["check", "C:\\Users\\A\\bin\\cinba.exe", "0.2.0"],
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

test("readiness dialog uses the strict message and defaults and cancels to Later", () => {
  assert.deepEqual(createDesktopReadinessPrompt("Wait for Core to finish."), {
    type: "info",
    title: "Cinba Update Is Waiting",
    message: "Wait for Core to finish.",
    buttons: ["Check Again", "Later"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
});

test("waiting then Later preserves observation, state, and handoff", async () => {
  const state = ready();
  const { calls, install } = fixture({
    getUpdate: () => state,
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

  assert.deepEqual(state, ready());
  assert.deepEqual(calls, [
    ["check", "C:\\Users\\A\\bin\\cinba.exe", "0.2.0"],
    ["readiness", "Wait for the active Core turn to finish.", false],
  ]);
});

test("waiting then Check Again retries read-only until ready", async () => {
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
    promptReadiness: async (message: string, error: boolean) => {
      calls.push(["readiness", message, error]);
      return true;
    },
  });

  await install();

  assert.deepEqual(calls, [
    ["check", "C:\\Users\\A\\bin\\cinba.exe", "0.2.0"],
    ["readiness", "Wait for Sync requests to finish.", false],
    ["check", "C:\\Users\\A\\bin\\cinba.exe", "0.2.0"],
    "abort",
    [
      "spawn",
      "C:\\Users\\A\\bin\\cinba.exe",
      ["__begin-update-handoff", "desktop", "123", "0.2.0"],
    ],
    "quit",
  ]);
});

test("multiple waiting checks never mutate Desktop or update lifecycle state", async () => {
  let prompts = 0;
  const { calls, install } = fixture({
    checkReadiness: async () => ({
      status: "waiting",
      reasonCode: "external-sync",
      message: "Sync is managed externally.",
    }),
    promptReadiness: async (message: string, error: boolean) => {
      calls.push(["readiness", message, error]);
      prompts += 1;
      return prompts < 3;
    },
  });

  await install();

  assert.equal(prompts, 3);
  assert.equal(calls.includes("abort"), false);
  assert.equal(calls.includes("resume"), false);
  assert.equal(calls.includes("quit"), false);
  assert.equal(
    calls.some((call) => Array.isArray(call) && call[0] === "spawn"),
    false,
  );
});

test("concurrent toolbar and tray requests share one waiting dialog", async () => {
  let answer!: (retry: boolean) => void;
  let checks = 0;
  const { calls, install } = fixture({
    checkReadiness: async () => {
      checks += 1;
      return {
        status: "waiting",
        reasonCode: "core-active-work",
        message: "Core is busy.",
      };
    },
    promptReadiness: async () =>
      await new Promise<boolean>((resolveAnswer) => {
        answer = resolveAnswer;
      }),
  });

  const toolbar = install();
  const tray = install();
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  assert.equal(checks, 1);
  answer(false);
  await Promise.all([toolbar, tray]);
  assert.deepEqual(calls, []);
});

test("readiness errors stay bounded, keep Desktop running, and permit retry", async () => {
  let checks = 0;
  const { calls, install } = fixture({
    checkReadiness: async () => {
      checks += 1;
      if (checks === 1) {
        throw new Error(`invalid readiness ${"x".repeat(3_000)}`);
      }
      return { status: "ready" };
    },
    promptReadiness: async (message: string, error: boolean) => {
      calls.push(["readiness", message, error]);
      assert.ok(message.length <= 2_048);
      return false;
    },
  });

  await install();
  assert.equal(calls.includes("quit"), false);
  await install();
  assert.equal(checks, 2);
  assert.equal(calls.at(-1), "quit");
});

test("candidate mismatch after waiting is an error and never installs another version", async () => {
  let update = ready("0.2.0");
  let checks = 0;
  const { calls, install } = fixture({
    getUpdate: () => update,
    checkReadiness: async (executable: string, version: string) => {
      calls.push(["check", executable, version]);
      checks += 1;
      if (checks === 1) {
        return {
          status: "waiting",
          reasonCode: "core-active-work",
          message: "Core is busy.",
        };
      }
      return { status: "ready" };
    },
    promptReadiness: async (message: string, error: boolean) => {
      calls.push(["readiness", message, error]);
      update = ready("0.3.0");
      return true;
    },
  });

  await install();

  assert.deepEqual(
    calls.filter((call) => Array.isArray(call) && call[0] === "check"),
    [["check", "C:\\Users\\A\\bin\\cinba.exe", "0.2.0"]],
  );
  assert.equal(calls.includes("abort"), false);
  assert.equal(calls.includes("quit"), false);
  assert.equal(
    calls.some(
      (call) =>
        Array.isArray(call) &&
        call[0] === "error" &&
        String(call[1]).includes("changed from 0.2.0"),
    ),
    true,
  );
});

test("readiness runner uses argv without a shell and parses the single JSON line", async () => {
  const child = fakeChild();
  let received: unknown;
  const pending = checkDesktopUpdateReadiness("C:\\Users\\A\\bin\\cinba.exe", "0.2.0", {}, ((
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
    {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  ]);
  child.stdout.emit("data", '{"status":"ready"}\n');
  child.emit("close", 0, null);
  assert.deepEqual(await pending, { status: "ready" });
});

test("readiness runner rejects non-zero, invalid, multiple, and oversized output with bounded errors", async () => {
  async function rejected(stdout: string, stderr: string, code: number): Promise<Error> {
    const child = fakeChild();
    const pending = checkDesktopUpdateReadiness("cinba", "0.2.0", {}, (() => child) as never);
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

test("readiness timeout kills a never-exiting child and a later request can retry", async () => {
  let killed = 0;
  const firstChild = fakeChild(() => {
    killed += 1;
    setImmediate(() => firstChild.emit("close", null, "SIGTERM"));
  });
  const first = checkDesktopUpdateReadiness(
    "cinba",
    "0.2.0",
    { timeoutMilliseconds: 5 },
    (() => firstChild) as never,
  );
  await assert.rejects(first, /timed out after 5ms/);
  assert.equal(killed, 1);

  const secondChild = fakeChild();
  const second = checkDesktopUpdateReadiness(
    "cinba",
    "0.2.0",
    { timeoutMilliseconds: 5 },
    (() => secondChild) as never,
  );
  secondChild.stdout.emit("data", '{"status":"ready"}\n');
  secondChild.emit("close", 0, null);
  assert.deepEqual(await second, { status: "ready" });
});

test("abort kills readiness and cleans its listener after child settlement", async () => {
  const controller = new AbortController();
  let killed = 0;
  const child = fakeChild(() => {
    killed += 1;
    setImmediate(() => child.emit("close", null, "SIGTERM"));
  });
  const pending = checkDesktopUpdateReadiness(
    "cinba",
    "0.2.0",
    { signal: controller.signal },
    (() => child) as never,
  );

  controller.abort();

  await assert.rejects(pending, /cancelled/);
  assert.equal(killed, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("readiness exit and abort races settle once without killing a completed child", async () => {
  const controller = new AbortController();
  let killed = 0;
  const child = fakeChild(() => {
    killed += 1;
  });
  const pending = checkDesktopUpdateReadiness(
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
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("readiness abort and child error races reject once without an unhandled close", async () => {
  const controller = new AbortController();
  const child = fakeChild();
  const pending = checkDesktopUpdateReadiness(
    "cinba",
    "0.2.0",
    { signal: controller.signal },
    (() => child) as never,
  );

  controller.abort();
  child.emit("error", new Error("kill raced with child failure"));
  child.emit("close", null, "SIGTERM");

  await assert.rejects(pending, /cancelled/);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("readiness and begin handoff expose distinct explicit timeouts", () => {
  assert.equal(DESKTOP_READINESS_TIMEOUT_MS, 10_000);
  assert.equal(DESKTOP_HANDOFF_TIMEOUT_MS, 60_000);
});

test("handoff launcher uses argv without a shell and resolves only on exit zero", async () => {
  const child = new EventEmitter();
  let received: unknown;
  const launched = launchDesktopUpdateHandoff(
    "C:\\Users\\A\\bin\\cinba.exe",
    ["__begin-update-handoff", "desktop", "123", "0.2.0"],
    {},
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
  child.emit("close", 0, null);
  await launched;
});

test("handoff launcher rejects process errors and non-zero exits", async () => {
  const failed = new EventEmitter();
  const spawnFailed = launchDesktopUpdateHandoff(
    "cinba",
    ["__begin-update-handoff", "desktop", "123", "0.2.0"],
    {},
    (() => failed) as never,
  );
  failed.emit("close", 9, null);
  await assert.rejects(spawnFailed, /exited with code 9/);

  const errored = new EventEmitter();
  const spawnErrored = launchDesktopUpdateHandoff(
    "cinba",
    ["__begin-update-handoff", "desktop", "123", "0.2.0"],
    {},
    (() => errored) as never,
  );
  const original = new Error("spawn denied");
  errored.emit("error", original);
  await assert.rejects(spawnErrored, (error) => error === original);
});

test("handoff timeout kills the short-lived begin child and waits for settlement", async () => {
  let killed = 0;
  const child = fakeChild(() => {
    killed += 1;
    setImmediate(() => child.emit("close", null, "SIGTERM"));
  });
  const pending = launchDesktopUpdateHandoff(
    "cinba",
    ["__begin-update-handoff", "desktop", "123", "0.2.0"],
    { timeoutMilliseconds: 5 },
    (() => child) as never,
  );

  await assert.rejects(pending, /timed out after 5ms/);
  assert.equal(killed, 1);
});
