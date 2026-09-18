import assert from "node:assert/strict";
import test from "node:test";
import { configureWindowsUserPath, removeWindowsUserPath } from "./windows-path.ts";

test("Windows PATH changes pass the launcher through environment, not script interpolation", async () => {
  const calls: { script: string; environment: NodeJS.ProcessEnv }[] = [];
  const result = await configureWindowsUserPath({
    launcherDirectory: "C:\\Users\\Ada Name\\AppData\\Local\\Programs\\Cinba\\bin",
    environment: { PATH: "system" },
    run: async (script, environment) => {
      calls.push({ script, environment });
      return { exitCode: 0, stdout: "updated\r\n", stderr: "" };
    },
  });
  assert.equal(result, "updated");
  assert.equal(calls[0]?.environment.CINBA_PATH_ACTION, "add");
  assert.equal(
    calls[0]?.environment.CINBA_PATH_DIRECTORY,
    "C:\\Users\\Ada Name\\AppData\\Local\\Programs\\Cinba\\bin",
  );
  assert.equal(calls[0]?.script.includes("Ada Name"), false);
});

test("Windows PATH removal deletes only the exact managed directory", async () => {
  assert.equal(
    await removeWindowsUserPath({
      launcherDirectory: "C:\\Cinba\\bin",
      run: async (script, environment) => {
        assert.match(script, /-ine \$directory/);
        assert.equal(environment.CINBA_PATH_ACTION, "remove");
        return { exitCode: 0, stdout: "removed\n", stderr: "" };
      },
    }),
    "removed",
  );
});

test("Windows PATH changes reject relative paths and unexpected PowerShell output", async () => {
  await assert.rejects(
    configureWindowsUserPath({ launcherDirectory: "relative\\bin" }),
    /absolute Windows path/,
  );
  await assert.rejects(
    configureWindowsUserPath({
      launcherDirectory: "C:\\Cinba\\bin",
      run: async () => ({ exitCode: 0, stdout: "surprise", stderr: "" }),
    }),
    /unexpected result/,
  );
});
