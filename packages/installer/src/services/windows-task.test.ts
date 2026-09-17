import assert from "node:assert/strict";
import test from "node:test";
import { resolveProductPaths } from "../paths.ts";
import { createManagedServiceDefinitions } from "./definitions.ts";
import {
  type RunPowerShell,
  createWindowsScheduledTaskAdapter,
  renderWindowsScheduledTaskRegistration,
} from "./windows-task.ts";

const paths = resolveProductPaths({ platform: "win32", homeDirectory: "C:\\Users\\cinba" });
const core = createManagedServiceDefinitions(paths, "win32").core;

test("Windows tasks run the stable launcher after interactive logon without elevation", () => {
  const script = renderWindowsScheduledTaskRegistration(core, "DESKTOP\\cinba");
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn -User 'DESKTOP\\cinba'/);
  assert.match(script, /-LogonType Interactive -RunLevel Limited/);
  assert.match(
    script,
    /-Execute 'C:\\Users\\cinba\\AppData\\Local\\Programs\\Cinba\\bin\\cinba\.exe'/,
  );
  assert.match(script, /-Argument 'service core'/);
  assert.doesNotMatch(script, /Password|Highest|releases/);
});

test("Windows task registration safely escapes PowerShell string values", () => {
  const script = renderWindowsScheduledTaskRegistration(
    { ...core, launcherPath: "C:\\Users\\O'Brien\\cinba.cmd" },
    "DESKTOP\\O'Brien",
  );
  assert.match(script, /O''Brien/);
  assert.doesNotMatch(script, /O'Brien/);
});

test("the adapter registers, starts, stops, inspects, and removes one current-user task", async () => {
  const scripts: string[] = [];
  let registered = false;
  let running = false;
  const runPowerShell: RunPowerShell = async (script) => {
    scripts.push(script);
    if (script.includes("Register-ScheduledTask")) {
      registered = true;
    } else if (script.includes("Unregister-ScheduledTask")) {
      registered = false;
    } else if (script.includes("Start-ScheduledTask")) {
      running = true;
    } else if (script.includes("Stop-ScheduledTask")) {
      running = false;
    }
    if (script.includes("Get-ScheduledTask")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ registered, running }),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const adapter = createWindowsScheduledTaskAdapter({
    userName: "DESKTOP\\cinba",
    runPowerShell,
  });
  await adapter.install(core);
  await adapter.start(core);
  assert.deepEqual(await adapter.inspect(core), { registered: true, running: true });
  await adapter.stop(core);
  await adapter.remove(core);
  assert.deepEqual(await adapter.inspect(core), { registered: false, running: false });
  assert.ok(scripts.every((script) => !script.includes("-Password")));
});
