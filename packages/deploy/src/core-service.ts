import { spawn } from "node:child_process";

type CommandResult = { stdout: string };
type RunCommand = (command: string, args: string[]) => Promise<CommandResult>;

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

/** Ask systemd to stop the core, which lets its SIGTERM drain finish, then verify it is down. */
export async function stopCoreService(runCommand: RunCommand = defaultRunCommand): Promise<void> {
  await runCommand("systemctl", ["--user", "stop", "cinba.service"]);
  const result = await runCommand("systemctl", [
    "--user",
    "show",
    "--property=ActiveState",
    "--value",
    "cinba.service",
  ]);
  if (result.stdout.trim() !== "inactive") {
    throw new Error("Cinba service did not become inactive after draining");
  }
}
