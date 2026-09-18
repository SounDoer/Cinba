import assert from "node:assert/strict";
import test from "node:test";
import {
  MACOS_INSTALL_PARENT_PROCESS_ID,
  parseMacosInstallHandoff,
  waitForMacosInstallerExit,
} from "./macos-install-handoff.ts";

test("the macOS installer handoff accepts only one positive parent process id", () => {
  assert.deepEqual(parseMacosInstallHandoff({ [MACOS_INSTALL_PARENT_PROCESS_ID]: "123" }), {
    parentProcessId: 123,
  });
  assert.equal(parseMacosInstallHandoff({}), undefined);
  for (const value of ["", "0", "-1", "1.5", "pid"] as const) {
    assert.throws(
      () => parseMacosInstallHandoff({ [MACOS_INSTALL_PARENT_PROCESS_ID]: value }),
      /positive process id/,
    );
  }
});

test("the bundle installer waits until its parent application exits", async () => {
  const observations = [true, true, false];
  let delays = 0;
  await waitForMacosInstallerExit(
    { parentProcessId: 123 },
    {
      exists: () => observations.shift() ?? false,
      delay: async () => {
        delays += 1;
      },
    },
  );
  assert.equal(delays, 2);
});

test("the bundle installer fails instead of waiting forever", async () => {
  await assert.rejects(
    waitForMacosInstallerExit(
      { parentProcessId: 123 },
      { exists: () => true, delay: async () => {}, attempts: 2 },
    ),
    /did not exit in time/,
  );
});
