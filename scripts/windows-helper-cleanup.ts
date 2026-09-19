import { spawn } from "node:child_process";
import { dirname } from "node:path";

/**
 * Removes a copied helper's directory after the helper exits. A running image cannot be deleted,
 * so the detached shell retries once a second until the removal succeeds or about two minutes
 * pass. This uses cmd.exe: Windows PowerShell started without a console (a detached child) exits
 * without running its -Command, which left every helper copy behind.
 */
export function scheduleWindowsHelperDirectoryRemoval(directory: string): void {
  const child = spawn(
    process.env.ComSpec ?? "cmd.exe",
    [
      "/d",
      "/v:off",
      "/s",
      "/c",
      '"for /l %i in (1,1,120) do (rmdir /s /q "%CINBA_HELPER_DIRECTORY%" 2>nul & (if not exist "%CINBA_HELPER_DIRECTORY%" exit 0) & ping -n 2 127.0.0.1 >nul)"',
    ],
    {
      cwd: dirname(directory),
      detached: true,
      env: { ...process.env, CINBA_HELPER_DIRECTORY: directory },
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: true,
    },
  );
  child.once("error", () => {});
  child.unref();
}
