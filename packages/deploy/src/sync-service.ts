import { spawn } from "node:child_process";

type CommandResult = { stdout: string };
type RunCommand = (command: string, args: string[]) => Promise<CommandResult>;
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function defaultRunCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve({ stdout });
        return;
      }
      reject(new Error(`${command} ${args[0] ?? "command"} failed with exit code ${code ?? -1}`));
    });
  });
}

/** Restart Sync onto the selected release only when this host already runs it. */
export async function refreshSyncService(
  runCommand: RunCommand = defaultRunCommand,
  options: {
    fetcher?: Fetch;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<void> {
  const before = await runCommand("systemctl", [
    "--user",
    "show",
    "--property=ActiveState",
    "--value",
    "cinba-sync.service",
  ]);
  if (before.stdout.trim() !== "active") {
    return;
  }
  await runCommand("systemctl", ["--user", "restart", "cinba-sync.service"]);
  const after = await runCommand("systemctl", [
    "--user",
    "show",
    "--property=ActiveState",
    "--value",
    "cinba-sync.service",
  ]);
  if (after.stdout.trim() !== "active") {
    throw new Error("Cinba Sync service did not become active after restart");
  }
  const fetcher = options.fetcher ?? fetch;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const deadline = now() + 30_000;
  while (true) {
    try {
      const response = await fetcher("http://127.0.0.1:4518/health", {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok && ((await response.json()) as { status?: unknown }).status === "ok") {
        return;
      }
    } catch {
      // A service may need a moment after systemd reports it active.
    }
    if (now() >= deadline) {
      throw new Error("Cinba Sync service did not pass its loopback health check");
    }
    await sleep(250);
  }
}
