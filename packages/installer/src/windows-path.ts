import { spawn } from "node:child_process";
import { win32 } from "node:path";

export type PowerShellPathResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type RunPathPowerShell = (
  script: string,
  environment: NodeJS.ProcessEnv,
) => Promise<PowerShellPathResult>;

// SetEnvironmentVariable for the User target already broadcasts WM_SETTINGCHANGE, so new
// terminals see the change. A second broadcast, with a 5-second timeout per window, took about
// 11 seconds on a Windows 11 test machine.
const USER_PATH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$directory = $env:CINBA_PATH_DIRECTORY
$action = $env:CINBA_PATH_ACTION
$current = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $current) { $current = '' }
$entries = @($current -split ';' | Where-Object { $_.Trim().Length -gt 0 })
$matches = @($entries | Where-Object { $_.TrimEnd('\') -ieq $directory.TrimEnd('\') })
if ($action -eq 'add') {
  if ($matches.Count -gt 0) { Write-Output 'already-available'; exit 0 }
  $updated = if ($entries.Count -eq 0) { $directory } else { ($entries + $directory) -join ';' }
  [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
  Write-Output 'updated'
} elseif ($action -eq 'remove') {
  if ($matches.Count -eq 0) { Write-Output 'absent'; exit 0 }
  $updated = @($entries | Where-Object { $_.TrimEnd('\') -ine $directory.TrimEnd('\') }) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
  Write-Output 'removed'
} else {
  throw 'unsupported Cinba PATH action'
}
`;

async function runPowerShell(
  script: string,
  environment: NodeJS.ProcessEnv,
): Promise<PowerShellPathResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Windows PATH update stopped by ${signal}`));
      } else {
        resolve({ exitCode: code ?? 0, stdout, stderr });
      }
    });
  });
}

async function updateWindowsUserPath(options: {
  action: "add" | "remove";
  launcherDirectory: string;
  environment?: NodeJS.ProcessEnv;
  run?: RunPathPowerShell;
}): Promise<string> {
  if (!win32.isAbsolute(options.launcherDirectory)) {
    throw new Error("Windows launcher directory must be an absolute Windows path");
  }
  const result = await (options.run ?? runPowerShell)(USER_PATH_SCRIPT, {
    ...(options.environment ?? process.env),
    CINBA_PATH_ACTION: options.action,
    CINBA_PATH_DIRECTORY: win32.normalize(options.launcherDirectory),
  });
  if (result.exitCode !== 0) {
    throw new Error(`could not ${options.action} Cinba in the current user PATH`);
  }
  const output = result.stdout.trim();
  const expected =
    options.action === "add" ? ["updated", "already-available"] : ["removed", "absent"];
  if (!expected.includes(output) || result.stderr.trim() !== "") {
    throw new Error("Windows PATH update returned an unexpected result");
  }
  return output;
}

export async function configureWindowsUserPath(options: {
  launcherDirectory: string;
  environment?: NodeJS.ProcessEnv;
  run?: RunPathPowerShell;
}): Promise<"updated" | "already-available"> {
  return (await updateWindowsUserPath({ ...options, action: "add" })) as
    "updated" | "already-available";
}

export async function removeWindowsUserPath(options: {
  launcherDirectory: string;
  environment?: NodeJS.ProcessEnv;
  run?: RunPathPowerShell;
}): Promise<"removed" | "absent"> {
  return (await updateWindowsUserPath({ ...options, action: "remove" })) as "removed" | "absent";
}
