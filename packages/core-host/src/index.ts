// The definition of "my core": how Pi starts, which provider and model it uses,
// which extensions it loads. All frontends share this one file, so the brain
// that wakes up is always the same one.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export type CoreOptions = {
  /** Working directory. Pi isolates sessions by it, so this decides which project is current. */
  cwd?: string;
  /** Model provider. */
  provider?: string;
  /** Model id. Left out, the provider's default model is used. */
  model?: string;
  /** Absolute paths of extra extension files to load. The permission gate comes built in and must not be passed here. */
  extensions?: string[];
};

export type SpawnPlan = {
  args: string[];
  env: Record<string, string | undefined>;
};

const DEFAULT_PROVIDER = "deepseek";

/**
 * Work out the arguments and environment for starting Pi.
 *
 * It is a pure function so it can be tested: the real spawn depends on runtime
 * state and cannot be, but whether the arguments are assembled correctly and
 * whether the environment carries what it must are both testable — and the
 * latter is exactly where an incident once came from.
 */
export function buildSpawnPlan(
  entry: string,
  gate: string,
  options: CoreOptions = {},
  baseEnv: Record<string, string | undefined> = process.env,
): SpawnPlan {
  const args: string[] = [entry, "--provider", options.provider ?? DEFAULT_PROVIDER];

  if (options.model) {
    args.push("--model", options.model);
  }

  // The permission gate always comes first and never travels through options:
  // it is an intrinsic property of this agent, not a caller's choice. Leaving
  // it to callers would mean whoever forgets it runs unguarded.
  for (const extension of [gate, ...(options.extensions ?? [])]) {
    args.push("-e", extension);
  }

  return {
    args,
    // Inside the Electron main process, process.execPath is electron.exe, not
    // node.exe. Without this variable, electron.exe loads rpc-entry.js as if it
    // were an app and exits immediately (measured: exit code 0, a single
    // newline on stdout, empty stderr — completely silent). The variable is
    // harmless under plain Node, so set it either way rather than branching.
    env: { ...baseEnv, ELECTRON_RUN_AS_NODE: "1" },
  };
}

/**
 * Start Pi's RPC process.
 *
 * Node runs Pi's rpc-entry directly instead of spawning the "pi" command: on
 * Windows pi is really pi.cmd, Node 18.20+ refuses to spawn a .cmd directly
 * (EINVAL), and working around that with shell: true trips the DEP0190
 * deprecation warning. Running the entry JS has neither problem.
 */
export function startCore(options: CoreOptions = {}): ChildProcess {
  // import.meta.resolve returns a file:// URL and spawn wants a plain path, so
  // convert. It has to be import.meta.resolve: that subpath declares only the
  // import condition, and CJS require.resolve fails with
  // ERR_PACKAGE_PATH_NOT_EXPORTED.
  const entry = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"),
  );

  const gate = fileURLToPath(
    import.meta.resolve("@cinba/extensions/src/permission-gate.ts"),
  );

  const plan = buildSpawnPlan(entry, gate, options);

  // stderr is piped rather than "inherit": an Electron GUI process on Windows
  // has no console attached, and "inherit" makes Pi's errors vanish entirely
  // (one phase 1b bug was hard to find for exactly this reason). The caller
  // decides where to forward it.
  return spawn(process.execPath, plan.args, {
    cwd: options.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: plan.env,
  });
}
