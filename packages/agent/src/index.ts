// Everything that touches Pi.
//
// One package, so "the Pi contact surface" is a place rather than a habit —
// the interface inventory in section 9 of the design doc is an inventory of
// this directory. Two things live here: how a Pi is started and configured
// (which provider, which conversation, and the permission gate that is mounted
// unconditionally), and how we speak to one once it is running.
//
// It depends on @cinba/contract because it produces view actions. Nothing here
// is imported by a frontend: a frontend that needed any of it would be reaching
// past the service into the core, which is the one rule the design has always
// had.

export { clearCredential, listProviders, setApiKey } from "./credentials.ts";
export { PiClient } from "./pi-client.ts";
export type { CoreEvent, CoreResponse, UiReply, UiRequest, UiRequestHandler } from "./pi-client.ts";
export { foldSessionEntries } from "./entries.ts";
export { createEventFolder, foldUiRequest } from "./events.ts";
export { StdioTransport } from "./transport.ts";
export type { Transport } from "./transport.ts";

// How a Pi is started: which provider and model, which conversation, which
// extensions. One definition, so whichever interface you are sitting in front
// of, the same agent wakes up — and so the permission gate cannot be left off
// by a caller who forgot it.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export type CoreOptions = {
  /** Working directory. Pi isolates sessions by it, so this decides which project is current. */
  cwd?: string;
  /** Model provider. */
  provider?: string;
  /** Model id. Left out, the provider's default model is used. */
  model?: string;
  /**
   * Path of an existing session file to carry on from. Left out, Pi starts a
   * fresh conversation.
   *
   * This is what makes a closed conversation reopenable: Pi stores the history
   * itself, so pointing a new process at the file brings the context back.
   */
  sessionPath?: string;
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

  if (options.sessionPath) {
    args.push("--session", options.sessionPath);
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
export function startPi(options: CoreOptions = {}): ChildProcess {
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

/**
 * One conversation Pi has stored.
 *
 * Pi keeps every conversation as an append-only JSONL file under
 * ~/.pi/agent/sessions/, one directory per working directory. We do not keep a
 * store of our own: reading these back is what lets a closed conversation be
 * reopened, and it means the `pi` command line and Cinba see the same history.
 */
export type StoredSession = {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  messageCount: number;
  /** The opening line of the conversation. Pi already has it, so nothing has to invent a title. */
  firstMessage: string;
  modified: Date;
};

/**
 * List stored conversations, newest first. Reads session files only — no Pi is
 * started, which is what makes a session list cheap enough to show on demand.
 *
 * @param cwd Restrict to conversations from this directory. Omitted, everything.
 */
export async function listSessions(cwd?: string): Promise<StoredSession[]> {
  const infos = cwd === undefined ? await SessionManager.listAll() : await SessionManager.list(cwd);
  return infos.map((info) => ({
    id: info.id,
    path: info.path,
    cwd: info.cwd,
    name: info.name,
    messageCount: info.messageCount,
    firstMessage: info.firstMessage,
    modified: info.modified,
  }));
}

/**
 * Look up one stored conversation, or undefined if it is gone.
 *
 * It carries its own working directory, and resuming it has to use that rather
 * than whatever directory happens to be current: a conversation about one
 * project must not come back with its tools pointed at another.
 */
export async function findSession(id: string): Promise<StoredSession | undefined> {
  const sessions = await listSessions();
  return sessions.find((session) => session.id === id);
}
