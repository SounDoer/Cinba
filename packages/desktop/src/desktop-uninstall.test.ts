import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  DesktopUninstallHandoffTimeoutError,
  confirmDesktopUninstall,
  createDesktopUninstall,
  createDesktopUninstallDialogs,
  launchDesktopUninstallHandoff,
} from "./desktop-uninstall.ts";

type FakeChild = EventEmitter & {
  stdout: EventEmitter & { destroy: () => void };
  stderr: EventEmitter & { destroy: () => void };
  kill: (signal?: NodeJS.Signals) => boolean;
  unref: () => void;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Object.assign(new EventEmitter(), { destroy: () => {} });
  child.stderr = Object.assign(new EventEmitter(), { destroy: () => {} });
  child.kill = () => true;
  child.unref = () => {};
  return child;
}

function fixture(overrides: Partial<Parameters<typeof createDesktopUninstall>[0]> = {}) {
  const calls: unknown[] = [];
  const uninstall = createDesktopUninstall({
    identity: "release",
    launcherPath: "C:\\Users\\A\\bin\\cinba.exe",
    processId: 123,
    confirm: async (mode) => {
      calls.push(["confirm", mode]);
      return true;
    },
    launch: async (executable, arguments_) => {
      calls.push(["launch", executable, arguments_]);
    },
    quit: () => calls.push(["quit"]),
    showError: async (message) => {
      calls.push(["error", message]);
    },
    ...overrides,
  });
  return { calls, uninstall };
}

test("every uninstall dialog defaults and cancels to Cancel", () => {
  for (const mode of ["normal", "purge"] as const) {
    for (const dialog of createDesktopUninstallDialogs(mode)) {
      assert.equal(dialog.buttons[1], "Cancel");
      assert.equal(dialog.defaultId, 1);
      assert.equal(dialog.cancelId, 1);
    }
  }
  const [normal] = createDesktopUninstallDialogs("normal");
  assert.match(normal!.detail, /kept/);
});

test("purge requires two confirmations and the acknowledgement checkbox", async () => {
  const dialogs = createDesktopUninstallDialogs("purge");
  assert.equal(dialogs.length, 2);
  assert.equal(dialogs[1]!.checkboxChecked, false);
  assert.ok(dialogs[1]!.checkboxLabel);

  const answers = (...results: { response: number; checkboxChecked: boolean }[]) => {
    const shown: string[] = [];
    return {
      shown,
      show: async (dialog: { message: string }) => {
        shown.push(dialog.message);
        return results.shift() ?? { response: 1, checkboxChecked: false };
      },
    };
  };

  const confirmed = answers(
    { response: 0, checkboxChecked: false },
    { response: 0, checkboxChecked: true },
  );
  assert.equal(await confirmDesktopUninstall("purge", confirmed.show), true);
  assert.equal(confirmed.shown.length, 2);

  const unchecked = answers(
    { response: 0, checkboxChecked: false },
    { response: 0, checkboxChecked: false },
  );
  assert.equal(await confirmDesktopUninstall("purge", unchecked.show), false);

  const cancelledFirst = answers({ response: 1, checkboxChecked: false });
  assert.equal(await confirmDesktopUninstall("purge", cancelledFirst.show), false);
  assert.equal(cancelledFirst.shown.length, 1);

  const normal = answers({ response: 0, checkboxChecked: false });
  assert.equal(await confirmDesktopUninstall("normal", normal.show), true);
  assert.equal(normal.shown.length, 1);
});

test("confirmed uninstall hands off to the launcher with the Desktop PID, then quits", async () => {
  const { calls, uninstall } = fixture();
  await uninstall("purge");
  assert.deepEqual(calls, [
    ["confirm", "purge"],
    ["launch", "C:\\Users\\A\\bin\\cinba.exe", ["__begin-uninstall", "desktop", "123", "purge"]],
    ["quit"],
  ]);
});

test("cancelling keeps Desktop running without launching", async () => {
  const { calls, uninstall } = fixture({ confirm: async () => false });
  await uninstall("normal");
  assert.deepEqual(calls, []);
});

test("a refused uninstall keeps Desktop running and explains why", async () => {
  const { calls, uninstall } = fixture({
    launch: async () => {
      throw new Error("Cinba cannot be uninstalled while the local Core has active work");
    },
  });
  await uninstall("normal");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], [
    "error",
    "Cinba cannot be uninstalled while the local Core has active work",
  ]);
});

test("an uncertain handoff quits instead of resuming Core work", async () => {
  const { calls, uninstall } = fixture({
    launch: async () => {
      throw new DesktopUninstallHandoffTimeoutError("timed out");
    },
  });
  await uninstall("normal");
  assert.equal(calls.at(-1)?.toString(), "quit");
});

test("development Desktop never uninstalls the product", async () => {
  const { calls, uninstall } = fixture({ identity: "development" });
  await uninstall("normal");
  assert.equal(calls.length, 1);
  assert.match(String((calls[0] as unknown[])[1]), /installed Cinba Desktop/);
});

test("concurrent requests share one confirmation and handoff", async () => {
  let release: (confirmed: boolean) => void = () => {};
  const { calls, uninstall } = fixture({
    confirm: (mode) => {
      calls.push(["confirm", mode]);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const first = uninstall("normal");
  const second = uninstall("purge");
  release(true);
  await Promise.all([first, second]);
  assert.equal(calls.filter((call) => (call as unknown[])[0] === "confirm").length, 1);
  assert.equal(calls.filter((call) => (call as unknown[])[0] === "launch").length, 1);
});

test("handoff runner captures stderr without a shell and reports the launcher's reason", async () => {
  const child = fakeChild();
  let received: unknown;
  const pending = launchDesktopUninstallHandoff(
    "cinba",
    ["__begin-uninstall", "desktop", "123", "normal"],
    {},
    ((executable: string, arguments_: readonly string[], options: unknown) => {
      received = [executable, arguments_, options];
      return child;
    }) as never,
  );
  assert.deepEqual(received, [
    "cinba",
    ["__begin-uninstall", "desktop", "123", "normal"],
    { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  ]);
  child.stderr.emit(
    "data",
    "[cinba] Cinba cannot be uninstalled while the local Core has active work\n",
  );
  child.emit("close", 1, null);
  await assert.rejects(pending, (error: Error) => {
    assert.equal(error.message, "Cinba cannot be uninstalled while the local Core has active work");
    return true;
  });

  const succeeded = fakeChild();
  const ok = launchDesktopUninstallHandoff("cinba", [], {}, (() => succeeded) as never);
  succeeded.emit("close", 0, null);
  await ok;
});
