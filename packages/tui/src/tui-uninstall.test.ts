import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import test from "node:test";
import { TuiUpdateHandoffController, blockTuiCoreInteractionDuringHandoff } from "./tui-update.ts";
import {
  TUI_PURGE_CONFIRMATION,
  TuiUninstallHandoffTimeoutError,
  createTuiUninstall,
  launchTuiUninstallHandoff,
} from "./tui-uninstall.ts";

const launcher = { path: resolve("bin", "cinba.exe"), processId: 123 };

function fixture(
  answers: { choice?: string; confirmed?: boolean; typed?: string } = {},
  overrides: Partial<Parameters<typeof createTuiUninstall>[0]> = {},
) {
  const calls: unknown[] = [];
  const handoffController = new TuiUpdateHandoffController();
  const state = { busy: false, compacting: false };
  const uninstall = createTuiUninstall({
    launcher,
    isBusy: () => state.busy,
    isCompacting: () => state.compacting,
    choose: async (title, choices) => {
      calls.push(["choose", title, choices.map((choice) => choice.value)]);
      return answers.choice;
    },
    confirm: async (confirmation) => {
      calls.push(["confirm", confirmation.title, confirmation.defaultConfirmed]);
      return answers.confirmed ?? false;
    },
    askText: async (label) => {
      calls.push(["ask", label]);
      return answers.typed;
    },
    handoffController,
    stopObserver: () => calls.push(["stop-observer"]),
    restartObserver: () => calls.push(["restart-observer"]),
    launch: async (executable, arguments_) => {
      calls.push(["launch", executable, arguments_, handoffController.inProgress]);
    },
    exit: () => calls.push(["exit"]),
    showNotice: (message) => calls.push(["notice", message]),
    ...overrides,
  });
  return { calls, handoffController, state, uninstall };
}

test("the keep-data uninstall is listed first and is the default choice", async () => {
  const { calls, uninstall } = fixture();
  await uninstall();
  assert.deepEqual(calls, [["choose", "Uninstall Cinba", ["normal", "purge"]]]);
});

test("normal uninstall confirms, hands off with the top launcher PID, and exits", async () => {
  const { calls, uninstall } = fixture({ choice: "normal", confirmed: true });
  await uninstall();
  assert.deepEqual(calls.slice(1), [
    ["confirm", "Uninstall Cinba", false],
    ["stop-observer"],
    ["launch", launcher.path, ["__begin-uninstall", "tui", "123", "normal"], true],
    ["exit"],
  ]);
});

test("purge requires confirmation and the exact typed phrase", async () => {
  const confirmed = fixture({ choice: "purge", confirmed: true, typed: TUI_PURGE_CONFIRMATION });
  await confirmed.uninstall();
  assert.deepEqual(confirmed.calls.at(-2), [
    "launch",
    launcher.path,
    ["__begin-uninstall", "tui", "123", "purge"],
    true,
  ]);

  for (const typed of [undefined, "delete all cinba data", "DELETE ALL CINBA DATA!"]) {
    const refused = fixture({ choice: "purge", confirmed: true, typed });
    await refused.uninstall();
    assert.equal(
      refused.calls.some((call) => (call as unknown[])[0] === "launch"),
      false,
    );
    assert.deepEqual(refused.calls.at(-1), [
      "notice",
      "Cinba purge cancelled; nothing was removed.",
    ]);
  }

  const declined = fixture({ choice: "purge", confirmed: false });
  await declined.uninstall();
  assert.equal(
    declined.calls.some((call) => (call as unknown[])[0] === "ask"),
    false,
  );
});

test("an answer in progress blocks uninstall before any choice", async () => {
  const { calls, state, uninstall } = fixture({ choice: "normal", confirmed: true });
  state.busy = true;
  await uninstall();
  assert.equal(calls.length, 1);
  assert.match(String((calls[0] as unknown[])[1]), /Wait for the current answer/);
});

test("development TUI cannot uninstall", async () => {
  const { calls, uninstall } = fixture({ choice: "normal" }, { launcher: undefined });
  await uninstall();
  assert.equal(calls.length, 1);
  assert.match(String((calls[0] as unknown[])[1]), /installed Cinba TUI/);
});

test("a refused handoff keeps the TUI running and reports the reason", async () => {
  const { calls, handoffController, uninstall } = fixture(
    { choice: "normal", confirmed: true },
    {
      launch: async () => {
        throw new Error("Cinba cannot be uninstalled while the local Core has active work");
      },
    },
  );
  await uninstall();
  assert.equal(handoffController.inProgress, false);
  assert.deepEqual(calls.slice(-2), [
    ["restart-observer"],
    ["notice", "Cinba cannot be uninstalled while the local Core has active work"],
  ]);
});

test("an uncertain handoff exits instead of accepting more Core work", async () => {
  const { calls, uninstall } = fixture(
    { choice: "normal", confirmed: true },
    {
      launch: async () => {
        throw new TuiUninstallHandoffTimeoutError("timed out");
      },
    },
  );
  await uninstall();
  assert.deepEqual(calls.at(-1), ["exit"]);
});

test("Core interaction during the uninstall handoff names the uninstall", () => {
  const controller = new TuiUpdateHandoffController();
  const handoff = controller.begin("uninstall");
  const notices: string[] = [];
  assert.equal(
    blockTuiCoreInteractionDuringHandoff(controller, (text) => notices.push(text)),
    true,
  );
  assert.deepEqual(notices, ["Preparing uninstall handoff…"]);
  handoff.finish();
});

test("handoff runner reports the launcher's stderr reason", async () => {
  const child = Object.assign(new EventEmitter(), {
    stderr: Object.assign(new EventEmitter(), { destroy: () => {} }),
    kill: () => true,
    unref: () => {},
  });
  let received: unknown;
  const pending = launchTuiUninstallHandoff(
    "cinba",
    ["__begin-uninstall", "tui", "123", "normal"],
    {},
    ((executable: string, arguments_: readonly string[], options: unknown) => {
      received = [executable, arguments_, options];
      return child;
    }) as never,
  );
  assert.deepEqual(received, [
    "cinba",
    ["__begin-uninstall", "tui", "123", "normal"],
    { shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  ]);
  child.stderr.emit(
    "data",
    "[cinba] Cinba cannot be uninstalled while the local Core has active work\n",
  );
  child.emit("close", 1, null);
  await assert.rejects(pending, /^Error: Cinba cannot be uninstalled while/);
});
