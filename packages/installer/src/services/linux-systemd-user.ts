import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { ManagedServiceDefinition } from "./definitions.ts";
import type { PlatformServiceAdapter, PlatformServiceSnapshot } from "./service-manager.ts";

export type ServiceCommandResult = { exitCode: number; stdout: string; stderr: string };
export type RunServiceCommand = (
  command: string,
  arguments_: readonly string[],
) => Promise<ServiceCommandResult>;

export type LinuxBackgroundSupport = {
  systemdUser: boolean;
  linger: boolean;
  authorizationRequired: boolean;
};

export class LinuxLingerRequiredError extends Error {
  override readonly name = "LinuxLingerRequiredError";
}

function defaultRunCommand(
  command: string,
  arguments_: readonly string[],
): Promise<ServiceCommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...arguments_], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
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

async function checked(
  runCommand: RunServiceCommand,
  command: string,
  arguments_: readonly string[],
): Promise<ServiceCommandResult> {
  const result = await runCommand(command, arguments_);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${arguments_[0] ?? "command"} failed with exit code ${result.exitCode}`,
    );
  }
  return result;
}

function quoteUnitArgument(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error("systemd service arguments cannot contain control characters");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function renderSystemdUserUnit(definition: ManagedServiceDefinition): string {
  if (!/^[a-z0-9-]+\.service$/.test(definition.registrationId)) {
    throw new Error("systemd registrationId must be a safe service unit name");
  }
  const command = [definition.launcherPath, ...definition.arguments]
    .map(quoteUnitArgument)
    .join(" ");
  const network =
    definition.component === "sync"
      ? "After=network-online.target\nWants=network-online.target\n"
      : "";
  return `[Unit]
Description=${definition.displayName}
${network}
[Service]
Type=simple
ExecStart=${command}
Restart=on-failure
RestartSec=5s
TimeoutStopSec=${Math.ceil(definition.stopTimeoutMs / 1_000)}s
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

export async function inspectLinuxBackgroundSupport(options: {
  userName: string;
  runCommand?: RunServiceCommand;
}): Promise<LinuxBackgroundSupport> {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const systemd = await runCommand("systemctl", ["--user", "show-environment"]);
  if (systemd.exitCode !== 0) {
    return { systemdUser: false, linger: false, authorizationRequired: false };
  }
  const linger = await runCommand("loginctl", [
    "show-user",
    options.userName,
    "--property=Linger",
    "--value",
  ]);
  const enabled = linger.exitCode === 0 && linger.stdout.trim() === "yes";
  return { systemdUser: true, linger: enabled, authorizationRequired: !enabled };
}

export async function enableLinuxLinger(options: {
  userName: string;
  authorization: { kind: "explicit-background-consent" };
  runCommand?: RunServiceCommand;
}): Promise<void> {
  if (options.authorization?.kind !== "explicit-background-consent") {
    throw new Error("enabling linger requires explicit Background consent");
  }
  await checked(options.runCommand ?? defaultRunCommand, "loginctl", [
    "enable-linger",
    options.userName,
  ]);
}

export function createLinuxSystemdUserAdapter(options: {
  userName: string;
  userUnitDirectory: string;
  runCommand?: RunServiceCommand;
}): PlatformServiceAdapter {
  if (!isAbsolute(options.userUnitDirectory)) {
    throw new Error("systemd userUnitDirectory must be absolute");
  }
  const runCommand = options.runCommand ?? defaultRunCommand;
  const unitPath = (definition: ManagedServiceDefinition) =>
    join(options.userUnitDirectory, definition.registrationId);
  const property = async (definition: ManagedServiceDefinition, name: string) => {
    const result = await checked(runCommand, "systemctl", [
      "--user",
      "show",
      definition.registrationId,
      `--property=${name}`,
      "--value",
    ]);
    return result.stdout.trim();
  };
  return {
    async inspect(definition): Promise<PlatformServiceSnapshot> {
      const loadState = await property(definition, "LoadState");
      const activeState = await property(definition, "ActiveState");
      return { registered: loadState === "loaded", running: activeState === "active" };
    },
    async install(definition) {
      const support = await inspectLinuxBackgroundSupport({
        userName: options.userName,
        runCommand,
      });
      if (!support.systemdUser) {
        throw new Error("systemd user services are not available");
      }
      if (!support.linger) {
        throw new LinuxLingerRequiredError(
          "Background requires linger so Cinba can survive logout and restart",
        );
      }
      const path = unitPath(definition);
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await mkdir(dirname(path), { recursive: true });
      try {
        await writeFile(temporary, renderSystemdUserUnit(definition), { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      await checked(runCommand, "systemctl", ["--user", "daemon-reload"]);
      await checked(runCommand, "systemctl", ["--user", "enable", definition.registrationId]);
    },
    async remove(definition) {
      await checked(runCommand, "systemctl", ["--user", "disable", definition.registrationId]);
      await rm(unitPath(definition), { force: true });
      await checked(runCommand, "systemctl", ["--user", "daemon-reload"]);
    },
    async start(definition) {
      await checked(runCommand, "systemctl", ["--user", "start", definition.registrationId]);
    },
    async stop(definition) {
      await checked(runCommand, "systemctl", ["--user", "stop", definition.registrationId]);
    },
  };
}
