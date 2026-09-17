import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { ManagedServiceDefinition } from "./definitions.ts";
import type { PlatformServiceAdapter, PlatformServiceSnapshot } from "./service-manager.ts";

export type LaunchctlResult = { exitCode: number; stdout: string; stderr: string };
export type RunLaunchctl = (arguments_: readonly string[]) => Promise<LaunchctlResult>;

function defaultRunLaunchctl(arguments_: readonly string[]): Promise<LaunchctlResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("launchctl", [...arguments_], {
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

function xml(value: string): string {
  if (value.includes("\0")) {
    throw new Error("LaunchAgent values cannot contain null characters");
  }
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function requireLabel(definition: ManagedServiceDefinition): string {
  if (!/^com\.soundoer\.cinba\.(core|sync)$/.test(definition.registrationId)) {
    throw new Error("LaunchAgent registrationId must be a known Cinba label");
  }
  return definition.registrationId;
}

export function renderMacosLaunchAgent(definition: ManagedServiceDefinition): string {
  const label = requireLabel(definition);
  const argumentsXml = [definition.launcherPath, ...definition.arguments]
    .map((argument) => `    <string>${xml(argument)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(definition.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(definition.logPath)}</string>
</dict>
</plist>
`;
}

async function checked(
  runLaunchctl: RunLaunchctl,
  arguments_: readonly string[],
): Promise<LaunchctlResult> {
  const result = await runLaunchctl(arguments_);
  if (result.exitCode !== 0) {
    throw new Error(
      `launchctl ${arguments_[0] ?? "command"} failed with exit code ${result.exitCode}`,
    );
  }
  return result;
}

export function createMacosLaunchAgentAdapter(options: {
  userId: number;
  launchAgentsDirectory: string;
  runLaunchctl?: RunLaunchctl;
}): PlatformServiceAdapter {
  if (!Number.isSafeInteger(options.userId) || options.userId < 0) {
    throw new Error("LaunchAgent userId must be a non-negative integer");
  }
  if (!isAbsolute(options.launchAgentsDirectory)) {
    throw new Error("launchAgentsDirectory must be absolute");
  }
  const runLaunchctl = options.runLaunchctl ?? defaultRunLaunchctl;
  const domain = `gui/${options.userId}`;
  const pathFor = (definition: ManagedServiceDefinition) =>
    join(options.launchAgentsDirectory, `${requireLabel(definition)}.plist`);
  const targetFor = (definition: ManagedServiceDefinition) =>
    `${domain}/${requireLabel(definition)}`;
  return {
    async inspect(definition): Promise<PlatformServiceSnapshot> {
      const result = await runLaunchctl(["print", targetFor(definition)]);
      if (result.exitCode !== 0) {
        return { registered: false, running: false };
      }
      return {
        registered: true,
        running: /^\s*state = running\s*$/m.test(result.stdout),
      };
    },
    async install(definition) {
      const path = pathFor(definition);
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await mkdir(dirname(path), { recursive: true });
      await mkdir(dirname(definition.logPath), { recursive: true });
      try {
        await writeFile(temporary, renderMacosLaunchAgent(definition), {
          flag: "wx",
          mode: 0o600,
        });
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      await checked(runLaunchctl, ["bootstrap", domain, path]);
    },
    async remove(definition) {
      await checked(runLaunchctl, ["bootout", targetFor(definition)]);
      await rm(pathFor(definition), { force: true });
    },
    async start(definition) {
      await checked(runLaunchctl, ["kickstart", targetFor(definition)]);
    },
    async stop(definition) {
      await checked(runLaunchctl, ["kill", "SIGTERM", targetFor(definition)]);
    },
  };
}
