import { spawn } from "node:child_process";
import { win32 } from "node:path";

export type RunWindowsIntegrationPowerShell = (
  script: string,
  environment: NodeJS.ProcessEnv,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const WINDOWS_INTEGRATION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$action = $env:CINBA_INTEGRATION_ACTION
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Cinba'
$shortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Cinba.lnk'
if ($action -eq 'install') {
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($shortcut)
  $link.TargetPath = $env:CINBA_DESKTOP_APPLICATION
  $link.WorkingDirectory = Split-Path $env:CINBA_DESKTOP_APPLICATION
  $link.IconLocation = "$($env:CINBA_DESKTOP_APPLICATION),0"
  $link.Save()

  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name DisplayName -Value 'Cinba' -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $key -Name DisplayVersion -Value $env:CINBA_PRODUCT_VERSION -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $key -Name Publisher -Value 'SounDoer' -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $key -Name DisplayIcon -Value $env:CINBA_DESKTOP_APPLICATION -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $key -Name InstallLocation -Value $env:CINBA_PROGRAM_DIRECTORY -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $key -Name UninstallString -Value ('"' + $env:CINBA_LAUNCHER + '" uninstall') -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $key -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $key -Name NoRepair -Value 1 -PropertyType DWord -Force | Out-Null
  Write-Output 'installed'
} elseif ($action -eq 'remove') {
  Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction SilentlyContinue
  Write-Output 'removed'
} else {
  throw 'unsupported Cinba Windows integration action'
}
`;

async function runPowerShell(
  script: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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
        reject(new Error(`Windows integration stopped by ${signal}`));
      } else {
        resolve({ exitCode: code ?? 0, stdout, stderr });
      }
    });
  });
}

function requireWindowsPath(path: string, description: string): string {
  if (!win32.isAbsolute(path)) {
    throw new Error(`${description} must be an absolute Windows path`);
  }
  return win32.normalize(path);
}

export async function configureWindowsProductIntegration(options: {
  programDirectory: string;
  launcherPath: string;
  desktopApplicationPath: string;
  version: string;
  environment?: NodeJS.ProcessEnv;
  run?: RunWindowsIntegrationPowerShell;
}): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(options.version)) {
    throw new Error("Windows product integration requires a stable SemVer");
  }
  const result = await (options.run ?? runPowerShell)(WINDOWS_INTEGRATION_SCRIPT, {
    ...(options.environment ?? process.env),
    CINBA_INTEGRATION_ACTION: "install",
    CINBA_PROGRAM_DIRECTORY: requireWindowsPath(options.programDirectory, "programDirectory"),
    CINBA_LAUNCHER: requireWindowsPath(options.launcherPath, "launcherPath"),
    CINBA_DESKTOP_APPLICATION: requireWindowsPath(
      options.desktopApplicationPath,
      "desktopApplicationPath",
    ),
    CINBA_PRODUCT_VERSION: options.version,
  });
  if (result.exitCode !== 0 || result.stdout.trim() !== "installed" || result.stderr.trim()) {
    throw new Error("could not register Cinba for the current Windows user");
  }
}

export async function removeWindowsProductIntegration(options: {
  environment?: NodeJS.ProcessEnv;
  run?: RunWindowsIntegrationPowerShell;
}): Promise<void> {
  const result = await (options.run ?? runPowerShell)(WINDOWS_INTEGRATION_SCRIPT, {
    ...(options.environment ?? process.env),
    CINBA_INTEGRATION_ACTION: "remove",
  });
  if (result.exitCode !== 0 || result.stdout.trim() !== "removed" || result.stderr.trim()) {
    throw new Error("could not remove Cinba registration for the current Windows user");
  }
}
