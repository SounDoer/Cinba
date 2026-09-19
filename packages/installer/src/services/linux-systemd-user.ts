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
  /** Why systemd user services cannot run here, or null when they can. */
  unavailableReason: string | null;
};

export class LinuxLingerRequiredError extends Error {
  override readonly name = "LinuxLingerRequiredError";
}

export class LinuxBackgroundUnavailableError extends Error {
  override readonly name = "LinuxBackgroundUnavailableError";
}

function lingerRequiredMessage(userName: string): string {
  return (
    `Background needs linger for user ${userName} so Cinba keeps running after logout and restarts. ` +
    `Run 'sudo loginctl enable-linger ${userName}' (or ask an administrator to), then retry. ` +
    "Cinba stays on-demand until then."
  );
}

function backgroundUnavailableMessage(reason: string, userName: string): string {
  return (
    `Background is unavailable because ${reason}; Cinba stays on-demand. ` +
    `On a systemd host, sign in through a regular login session or run 'sudo loginctl enable-linger ${userName}', then retry.`
  );
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

/** Runs a command on the caller's terminal so polkit or sudo can ask for authorization. */
function defaultRunInteractiveCommand(
  command: string,
  arguments_: readonly string[],
): Promise<ServiceCommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...arguments_], { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ exitCode: code ?? -1, stdout: "", stderr: "" }));
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
  const unavailableReason = await probeSystemdUser(runCommand);
  if (unavailableReason) {
    return { systemdUser: false, linger: false, authorizationRequired: false, unavailableReason };
  }
  const enabled = await lingerEnabled(runCommand, options.userName);
  return {
    systemdUser: true,
    linger: enabled,
    authorizationRequired: !enabled,
    unavailableReason: null,
  };
}

function missingCommand(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function probeSystemdUser(runCommand: RunServiceCommand): Promise<string | null> {
  let result: ServiceCommandResult;
  try {
    result = await runCommand("systemctl", ["--user", "show-environment"]);
  } catch (error) {
    if (missingCommand(error)) {
      return "this host does not run systemd (systemctl was not found)";
    }
    throw error;
  }
  if (result.exitCode === 0) {
    return null;
  }
  const detail = result.stderr.trim().split("\n")[0]?.trim();
  return `the systemd user manager is not running for this user${detail ? ` (${detail})` : ""}`;
}

async function lingerEnabled(runCommand: RunServiceCommand, userName: string): Promise<boolean> {
  try {
    const result = await runCommand("loginctl", [
      "show-user",
      userName,
      "--property=Linger",
      "--value",
    ]);
    return result.exitCode === 0 && result.stdout.trim() === "yes";
  } catch (error) {
    if (missingCommand(error)) {
      return false;
    }
    throw error;
  }
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
  /**
   * Asks the user whether Cinba may enable linger for them. Only an interactive caller that
   * explicitly requested Background provides this; without it, missing linger is reported.
   */
  authorizeLinger?: (userName: string) => Promise<boolean>;
  runInteractiveCommand?: RunServiceCommand;
}): PlatformServiceAdapter {
  if (!isAbsolute(options.userUnitDirectory)) {
    throw new Error("systemd userUnitDirectory must be absolute");
  }
  const runCommand = options.runCommand ?? defaultRunCommand;
  // Once the user manager answered it stays available; only a missing one is probed again.
  let systemdUserAvailable = false;
  const unavailableReason = async (): Promise<string | null> => {
    if (systemdUserAvailable) {
      return null;
    }
    const reason = await probeSystemdUser(runCommand);
    systemdUserAvailable = reason === null;
    return reason;
  };
  const requireBackgroundSupport = async () => {
    const support = await inspectLinuxBackgroundSupport({
      userName: options.userName,
      runCommand,
    });
    if (support.unavailableReason) {
      throw new LinuxBackgroundUnavailableError(
        backgroundUnavailableMessage(support.unavailableReason, options.userName),
      );
    }
    return support;
  };
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
      // Without a user manager nothing can be registered, so there is nothing to inspect.
      const reason = await unavailableReason();
      if (reason) {
        return { registered: false, running: false, backgroundUnavailable: reason };
      }
      const loadState = await property(definition, "LoadState");
      const activeState = await property(definition, "ActiveState");
      return { registered: loadState === "loaded", running: activeState === "active" };
    },
    async prepareBackground() {
      const support = await requireBackgroundSupport();
      if (support.linger) {
        return;
      }
      if (!options.authorizeLinger || !(await options.authorizeLinger(options.userName))) {
        throw new LinuxLingerRequiredError(lingerRequiredMessage(options.userName));
      }
      try {
        await enableLinuxLinger({
          userName: options.userName,
          authorization: { kind: "explicit-background-consent" },
          runCommand: options.runInteractiveCommand ?? defaultRunInteractiveCommand,
        });
      } catch (error) {
        throw new LinuxLingerRequiredError(
          `Enabling linger was not authorized. ${lingerRequiredMessage(options.userName)}`,
          { cause: error },
        );
      }
      if (!(await lingerEnabled(runCommand, options.userName))) {
        throw new LinuxLingerRequiredError(lingerRequiredMessage(options.userName));
      }
    },
    async install(definition) {
      const support = await requireBackgroundSupport();
      if (!support.linger) {
        throw new LinuxLingerRequiredError(lingerRequiredMessage(options.userName));
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
