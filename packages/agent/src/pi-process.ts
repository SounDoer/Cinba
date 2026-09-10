// Builds and starts the Pi RPC child process used by one live conversation.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export type CoreOptions = {
  cwd?: string;
  provider?: string;
  model?: string;
  sessionPath?: string;
  extensions?: string[];
};

export type SpawnPlan = {
  args: string[];
  env: Record<string, string | undefined>;
};

const DEFAULT_PROVIDER = "deepseek";

/** Build the process arguments separately so they can be tested without spawning Pi. */
export function buildSpawnPlan(
  entry: string,
  gate: string,
  options: CoreOptions = {},
  baseEnv: Record<string, string | undefined> = process.env,
): SpawnPlan {
  const args: string[] = [entry, "--provider", options.provider ?? DEFAULT_PROVIDER];

  if (options.model) args.push("--model", options.model);
  if (options.sessionPath) args.push("--session", options.sessionPath);

  // The permission gate is intrinsic, not an option callers can forget.
  for (const extension of [gate, ...(options.extensions ?? [])]) {
    args.push("-e", extension);
  }

  return {
    args,
    // Electron's executable must behave as Node when it runs Pi's JS entrypoint.
    env: { ...baseEnv, ELECTRON_RUN_AS_NODE: "1" },
  };
}

/** Start Pi's JS RPC entry directly, avoiding platform-specific command wrappers. */
export function startPi(options: CoreOptions = {}): ChildProcess {
  const entry = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"),
  );
  const gate = fileURLToPath(
    import.meta.resolve("@cinba/extensions/src/permission-gate.ts"),
  );
  const plan = buildSpawnPlan(entry, gate, options);

  return spawn(process.execPath, plan.args, {
    cwd: options.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: plan.env,
  });
}
