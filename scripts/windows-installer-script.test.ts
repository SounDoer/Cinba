import assert from "node:assert/strict";
import test from "node:test";
import { renderWindowsInstallerScript } from "./windows-installer-script.ts";

test("the Windows setup delegates installation and offers to launch Cinba", () => {
  const script = renderWindowsInstallerScript({
    version: "0.1.0",
    bundleDirectory: "C:\\build\\bundle",
    outputPath: "C:\\build\\Cinba-0.1.0-windows-x64.exe",
  });
  assert.match(script, /RequestExecutionLevel user/);
  assert.match(
    script,
    /nsExec::ExecToLog '"\$PLUGINSDIR\\CinbaBundle\\launcher\\cinba\.exe" install --consume-bundle --failure-log "\$PLUGINSDIR\\install-failure\.txt"'/,
  );
  assert.match(
    script,
    /MessageBox MB_ICONSTOP "Cinba installation failed \(exit code \$0\)\.\$\\r\$\\n\$\\r\$\\n\$1"/,
  );
  assert.match(script, /\$\{If\} \$0 != 0/);
  assert.match(script, /MUI_FINISHPAGE_RUN_CHECKED/);
  assert.match(script, /Programs\\Cinba\\desktop\\Cinba\.exe/);
  assert.doesNotMatch(script, /CreateShortCut[^\n]*Desktop/);
});

test("the Windows setup streams installer output and still reports the failure line", () => {
  const script = renderWindowsInstallerScript({
    version: "0.1.0",
    bundleDirectory: "C:\\build\\bundle",
    outputPath: "C:\\build\\Cinba-0.1.0-windows-x64.exe",
  });
  assert.doesNotMatch(script, /ExecToStack/);
  assert.match(script, /DetailPrint "Installing Cinba\. This usually takes a few minutes\."/);
  assert.doesNotMatch(script, /DetailPrint[^\n]*uninstall/);
  assert.match(script, /StrCpy \$1 "See the installation details for what failed\."/);
  assert.match(script, /FileOpen \$2 "\$PLUGINSDIR\\install-failure\.txt" r/);
  assert.match(script, /\$\{IfNot\} \$\{Errors\}\n      FileRead \$2 \$3\n      FileClose \$2/);
  assert.match(script, /\$\{If\} \$3 != ""\n        StrCpy \$1 \$3/);
});

test("the Windows setup stops working inside the bundle directory before it exits", () => {
  const script = renderWindowsInstallerScript({
    version: "0.1.0",
    bundleDirectory: "C:\\build\\bundle",
    outputPath: "C:\\build\\Cinba-0.1.0-windows-x64.exe",
  });
  // SetOutPath makes the bundle directory setup's working directory, and Windows cannot remove a
  // directory a running process works in, so setup's own cleanup would leave $PLUGINSDIR behind.
  const enter = script.indexOf('SetOutPath "$PLUGINSDIR\\CinbaBundle"');
  const install = script.indexOf("nsExec::ExecToLog");
  const leave = script.indexOf('SetOutPath "$TEMP"');
  const failure = script.indexOf("MessageBox MB_ICONSTOP");
  assert.ok(enter !== -1 && enter < install, "setup extracts the bundle before installing");
  assert.ok(install < leave, "setup leaves the bundle directory once the installer is done");
  assert.ok(leave < failure, "setup leaves the bundle directory even when the install fails");
});

test("NSIS paths cannot inject new directives", () => {
  assert.throws(
    () =>
      renderWindowsInstallerScript({
        version: "0.1.0",
        bundleDirectory: 'C:\\bundle\n!system "bad"',
        outputPath: "C:\\setup.exe",
      }),
    /control characters/,
  );
});

test("the Windows setup lets the installer consume the bundle it extracted", () => {
  const script = renderWindowsInstallerScript({
    version: "0.1.0",
    bundleDirectory: "C:\\build\\bundle",
    outputPath: "C:\\build\\Cinba-0.1.0-windows-x64.exe",
  });
  // $PLUGINSDIR is deleted when setup exits, so moving the payload out of it is safe and skips
  // copying 450 MiB a second time.
  assert.match(script, /cinba\.exe" install --consume-bundle /);
});
