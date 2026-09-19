import { spawn } from "node:child_process";
import { dirname } from "node:path";

/**
 * Removes a copied helper's directory after the helper exits. A running image cannot be deleted,
 * so the detached shell retries once a second until the removal succeeds or about two minutes
 * pass. This uses cmd.exe: Windows PowerShell started without a console (a detached child) exits
 * without running its -Command, which left every helper copy behind.
 *
 * With `failureLog`, a removal that never succeeds appends a line to that file.
 */
export function scheduleWindowsHelperDirectoryRemoval(
  directory: string,
  options: { failureLog?: string; attempts?: number } = {},
): void {
  const attempts = options.attempts ?? 120;
  // Success exits inside the loop, so the logging step runs only after every attempt failed.
  const logFailure = options.failureLog
    ? ' & mkdir "%CINBA_FAILURE_LOG_DIRECTORY%" 2>nul & echo %DATE% %TIME% uninstall failed: a Cinba directory could not be removed>>"%CINBA_FAILURE_LOG%"'
    : "";
  const child = spawn(
    process.env.ComSpec ?? "cmd.exe",
    [
      "/d",
      "/v:off",
      "/s",
      "/c",
      `"(for /l %i in (1,1,${String(attempts)}) do (rmdir /s /q "%CINBA_HELPER_DIRECTORY%" 2>nul & (if not exist "%CINBA_HELPER_DIRECTORY%" exit 0) & ping -n 2 127.0.0.1 >nul))${logFailure}"`,
    ],
    {
      cwd: dirname(directory),
      detached: true,
      env: {
        ...process.env,
        CINBA_HELPER_DIRECTORY: directory,
        ...(options.failureLog
          ? {
              CINBA_FAILURE_LOG: options.failureLog,
              CINBA_FAILURE_LOG_DIRECTORY: dirname(options.failureLog),
            }
          : {}),
      },
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: true,
    },
  );
  child.once("error", () => {});
  child.unref();
}
