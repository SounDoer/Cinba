import { spawn } from "node:child_process";

const LOCK_BUSY_EXIT_CODE = 75;

type RunCommand = (command: string, args: string[]) => Promise<number>;

function defaultRunCommand(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? -1));
  });
}

/** Hold a kernel flock for the entire child deployment; lock contention is a quiet no-op. */
export async function runWithDeploymentLock(
  options: { lockPath: string; scriptPath: string; nodePath?: string },
  runCommand: RunCommand = defaultRunCommand,
): Promise<"completed" | "busy"> {
  const code = await runCommand("flock", [
    "--exclusive",
    "--nonblock",
    "--conflict-exit-code",
    String(LOCK_BUSY_EXIT_CODE),
    "--",
    options.lockPath,
    options.nodePath ?? process.execPath,
    options.scriptPath,
  ]);
  if (code === LOCK_BUSY_EXIT_CODE) {
    return "busy";
  }
  if (code !== 0) {
    throw new Error(`Locked deployment exited with code ${code}`);
  }
  return "completed";
}
