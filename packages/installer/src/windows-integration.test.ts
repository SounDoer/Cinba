import assert from "node:assert/strict";
import test from "node:test";
import {
  configureWindowsProductIntegration,
  removeWindowsProductIntegration,
  stopWindowsDesktopApplication,
} from "./windows-integration.ts";

test("Windows product registration receives paths through environment only", async () => {
  let received: NodeJS.ProcessEnv | undefined;
  await configureWindowsProductIntegration({
    programDirectory: "C:\\Users\\Ada Name\\AppData\\Local\\Programs\\Cinba",
    launcherPath: "C:\\Users\\Ada Name\\AppData\\Local\\Programs\\Cinba\\bin\\cinba.exe",
    desktopApplicationPath:
      "C:\\Users\\Ada Name\\AppData\\Local\\Programs\\Cinba\\desktop\\Cinba.exe",
    version: "0.1.0",
    environment: { APPDATA: "C:\\Users\\Ada Name\\AppData\\Roaming" },
    run: async (script, environment) => {
      received = environment;
      assert.equal(script.includes("Ada Name"), false);
      assert.match(script, /UninstallString/);
      assert.doesNotMatch(script, /Desktop\\Cinba\.lnk/);
      return { exitCode: 0, stdout: "installed\r\n", stderr: "" };
    },
  });
  assert.equal(received?.CINBA_INTEGRATION_ACTION, "install");
  assert.equal(received?.CINBA_PRODUCT_VERSION, "0.1.0");
  assert.match(received?.CINBA_DESKTOP_APPLICATION ?? "", /desktop\\Cinba\.exe$/);
});

test("Windows product integration removal owns only its shortcut and registry key", async () => {
  await removeWindowsProductIntegration({
    run: async (script, environment) => {
      assert.equal(environment.CINBA_INTEGRATION_ACTION, "remove");
      assert.match(script, /Start Menu\\Programs\\Cinba\.lnk/);
      assert.match(script, /CurrentVersion\\Uninstall\\Cinba/);
      return { exitCode: 0, stdout: "removed\n", stderr: "" };
    },
  });
});

test("Windows product registration rejects unstable versions and relative paths", async () => {
  const base = {
    programDirectory: "C:\\Cinba",
    launcherPath: "C:\\Cinba\\cinba.exe",
    desktopApplicationPath: "C:\\Cinba\\Cinba.exe",
  };
  await assert.rejects(
    configureWindowsProductIntegration({ ...base, version: "0.1.0-beta.1" }),
    /stable SemVer/,
  );
  await assert.rejects(
    configureWindowsProductIntegration({
      ...base,
      launcherPath: "relative\\cinba.exe",
      version: "0.1.0",
    }),
    /absolute Windows path/,
  );
});

test("uninstall stops only the Desktop running from the installed path", async () => {
  const desktopApplicationPath =
    "C:\\Users\\Ada Name\\AppData\\Local\\Programs\\Cinba\\desktop\\Cinba.exe";
  const stopped = await stopWindowsDesktopApplication({
    desktopApplicationPath,
    environment: {},
    run: async (script, environment) => {
      assert.equal(script.includes("Ada Name"), false);
      assert.match(script, /ExecutablePath -eq \$path/);
      assert.match(script, /Stop-Process/);
      assert.equal(environment.CINBA_DESKTOP_APPLICATION, desktopApplicationPath);
      return { exitCode: 0, stdout: "stopped 3\r\n", stderr: "" };
    },
  });
  assert.equal(stopped, 3);
});

test("uninstall refuses to continue while Desktop survives the stop request", async () => {
  await assert.rejects(
    stopWindowsDesktopApplication({
      desktopApplicationPath: "C:\\Cinba\\desktop\\Cinba.exe",
      run: async () => ({ exitCode: 0, stdout: "running\n", stderr: "" }),
    }),
    /Cinba Desktop is still running/,
  );
  await assert.rejects(
    stopWindowsDesktopApplication({ desktopApplicationPath: "desktop\\Cinba.exe" }),
    /absolute Windows path/,
  );
});
