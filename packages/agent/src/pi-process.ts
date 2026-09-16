// Builds and starts the Pi RPC child process used by one live conversation.

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildProviderEnvironment } from "./provider-environment.ts";

export type CoreOptions = {
  cwd?: string;
  provider?: string;
  model?: string;
  sessionPath?: string;
  extensions?: string[];
  /** Explicit per-process project trust decision made by the Cinba host. */
  projectTrusted?: boolean;
  /** One credential already selected by the Core for this exact Provider. */
  providerCredential?: string;
  webToolsRuntimeConfig?: string;
};

export type SpawnPlan = {
  args: string[];
  env: Record<string, string | undefined>;
  windowsHide: true;
};

const DEFAULT_PROVIDER = "deepseek";

/** Build the process arguments separately so they can be tested without spawning Pi. */
export function buildSpawnPlan(
  entry: string,
  intrinsicExtensions: readonly string[],
  options: CoreOptions = {},
  baseEnv: Record<string, string | undefined> = process.env,
): SpawnPlan {
  const args: string[] = [entry, "--provider", options.provider ?? DEFAULT_PROVIDER];

  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.sessionPath) {
    args.push("--session", options.sessionPath);
  }
  if (options.projectTrusted !== undefined) {
    args.push(options.projectTrusted ? "--approve" : "--no-approve");
  }

  for (const extension of [...intrinsicExtensions, ...(options.extensions ?? [])]) {
    args.push("-e", extension);
  }

  return {
    args,
    // Electron's executable must behave as Node when it runs Pi's JS entrypoint.
    env: {
      ...buildProviderEnvironment({
        providerId: options.provider ?? DEFAULT_PROVIDER,
        apiKey: options.providerCredential,
        baseEnvironment: baseEnv,
      }),
      ELECTRON_RUN_AS_NODE: "1",
      ...(options.webToolsRuntimeConfig
        ? { CINBA_WEB_TOOLS_RUNTIME_CONFIG: options.webToolsRuntimeConfig }
        : {}),
    },
    windowsHide: true,
  };
}

/** Start Pi's JS RPC entry directly, avoiding platform-specific command wrappers. */
export function startPi(options: CoreOptions = {}): ChildProcess {
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
  const gate = fileURLToPath(import.meta.resolve("@cinba/extensions/src/permission-gate.ts"));
  const sessionEdit = fileURLToPath(import.meta.resolve("@cinba/extensions/src/session-edit.ts"));
  const webTools = fileURLToPath(import.meta.resolve("@cinba/extensions/src/web-tools.ts"));
  const plan = buildSpawnPlan(entry, [gate, sessionEdit, webTools], options);

  return spawn(process.execPath, plan.args, {
    cwd: options.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: plan.env,
    windowsHide: plan.windowsHide,
  });
}
