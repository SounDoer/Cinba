import { spawn } from "node:child_process";
import type { ManagedServiceDefinition } from "./definitions.ts";
import type { PlatformServiceAdapter, PlatformServiceSnapshot } from "./service-manager.ts";

export type PowerShellResult = { exitCode: number; stdout: string; stderr: string };
export type RunPowerShell = (script: string) => Promise<PowerShellResult>;

type WindowsTaskIdentity = { taskPath: string; taskName: string };

function defaultRunPowerShell(script: string): Promise<PowerShellResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ exitCode: code ?? -1, stdout, stderr }));
  });
}

function powerShellString(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error("scheduled task values cannot contain control characters");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function taskIdentity(definition: ManagedServiceDefinition): WindowsTaskIdentity {
  const match = /^\\Cinba\\(Core|Sync)$/.exec(definition.registrationId);
  if (!match?.[1]) {
    throw new Error("Windows registrationId must be a known Cinba task path");
  }
  return { taskPath: "\\Cinba\\", taskName: match[1] };
}

function taskArguments(definition: ManagedServiceDefinition): string {
  for (const argument of definition.arguments) {
    if (/\s|"/.test(argument)) {
      throw new Error("Windows service arguments must not require command-line quoting");
    }
  }
  return definition.arguments.join(" ");
}

export function renderWindowsScheduledTaskRegistration(
  definition: ManagedServiceDefinition,
  userName: string,
): string {
  const identity = taskIdentity(definition);
  if (userName.trim() === "") {
    throw new Error("Windows scheduled tasks require a current user name");
  }
  const launcher = powerShellString(definition.launcherPath);
  const argumentsText = powerShellString(taskArguments(definition));
  const user = powerShellString(userName);
  const taskPath = powerShellString(identity.taskPath);
  const taskName = powerShellString(identity.taskName);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$action = New-ScheduledTaskAction -Execute ${launcher} -Argument ${argumentsText}`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn -User ${user}`,
    `$principal = New-ScheduledTaskPrincipal -UserId ${user} -LogonType Interactive -RunLevel Limited`,
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew",
    `Register-ScheduledTask -TaskPath ${taskPath} -TaskName ${taskName} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description ${powerShellString(definition.displayName)} -Force | Out-Null`,
  ].join("\n");
}

async function checked(runPowerShell: RunPowerShell, script: string): Promise<PowerShellResult> {
  const result = await runPowerShell(script);
  if (result.exitCode !== 0) {
    throw new Error(`PowerShell scheduled task command failed with exit code ${result.exitCode}`);
  }
  return result;
}

function taskCommand(definition: ManagedServiceDefinition, command: string): string {
  const identity = taskIdentity(definition);
  return `$ErrorActionPreference = 'Stop'\n${command} -TaskPath ${powerShellString(identity.taskPath)} -TaskName ${powerShellString(identity.taskName)}`;
}

function inspectCommand(definition: ManagedServiceDefinition): string {
  const identity = taskIdentity(definition);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$task = Get-ScheduledTask -TaskPath ${powerShellString(identity.taskPath)} -TaskName ${powerShellString(identity.taskName)} -ErrorAction SilentlyContinue`,
    "if ($null -eq $task) {",
    "  [pscustomobject]@{ registered = $false; running = $false } | ConvertTo-Json -Compress",
    "} else {",
    "  [pscustomobject]@{ registered = $true; running = ([string]$task.State -eq 'Running') } | ConvertTo-Json -Compress",
    "}",
  ].join("\n");
}

function parseSnapshot(value: string): PlatformServiceSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim());
  } catch {
    throw new Error("Windows scheduled task inspection returned invalid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).registered !== "boolean" ||
    typeof (parsed as Record<string, unknown>).running !== "boolean"
  ) {
    throw new Error("Windows scheduled task inspection returned an invalid snapshot");
  }
  return {
    registered: (parsed as Record<string, boolean>).registered,
    running: (parsed as Record<string, boolean>).running,
  };
}

export function createWindowsScheduledTaskAdapter(options: {
  userName: string;
  runPowerShell?: RunPowerShell;
}): PlatformServiceAdapter {
  const runPowerShell = options.runPowerShell ?? defaultRunPowerShell;
  return {
    async inspect(definition) {
      const result = await checked(runPowerShell, inspectCommand(definition));
      return parseSnapshot(result.stdout);
    },
    async install(definition) {
      await checked(
        runPowerShell,
        renderWindowsScheduledTaskRegistration(definition, options.userName),
      );
    },
    async remove(definition) {
      await checked(
        runPowerShell,
        `${taskCommand(definition, "Unregister-ScheduledTask")} -Confirm:$false`,
      );
    },
    async start(definition) {
      await checked(runPowerShell, taskCommand(definition, "Start-ScheduledTask"));
    },
    async stop(definition) {
      await checked(runPowerShell, taskCommand(definition, "Stop-ScheduledTask"));
    },
  };
}
