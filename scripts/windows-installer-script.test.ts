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
    /nsExec::ExecToStack '"\$PLUGINSDIR\\CinbaBundle\\launcher\\cinba\.exe" install'/,
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
