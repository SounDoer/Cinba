import { spawn } from "node:child_process";

type CommandResult = { stdout: string };
type RunCommand = (
  command: string,
  args: string[],
  options?: { showOutput?: boolean },
) => Promise<CommandResult>;

function defaultRunCommand(
  command: string,
  args: string[],
  options: { showOutput?: boolean } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (options.showOutput) {
        process.stdout.write(chunk);
      }
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

async function requireCleanMaster(runCommand: RunCommand): Promise<string> {
  const branch = (await runCommand("git", ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
  if (branch !== "master") {
    throw new Error("Promotion requires the master branch");
  }
  const changes = (await runCommand("git", ["status", "--porcelain"])).stdout;
  if (changes.trim()) {
    throw new Error("Promotion requires a clean working tree");
  }

  await runCommand("git", ["fetch", "--quiet", "origin", "master"]);
  const local = (await runCommand("git", ["rev-parse", "HEAD"])).stdout.trim().toLowerCase();
  const remote = (await runCommand("git", ["rev-parse", "refs/remotes/origin/master"])).stdout
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(local) || local !== remote) {
    throw new Error("master must exactly match origin/master before promotion");
  }
  return local;
}

/** Promote the already-pushed master commit to prod without creating or forcing history. */
export async function promote(
  runCommand: RunCommand = defaultRunCommand,
  npmCliPath = process.env.npm_execpath,
): Promise<string> {
  const revision = await requireCleanMaster(runCommand);
  if (!npmCliPath) {
    throw new Error("Promotion must be started through npm run promote");
  }
  await runCommand(process.execPath, [npmCliPath, "run", "check"], { showOutput: true });

  const afterChecks = (await runCommand("git", ["status", "--porcelain"])).stdout;
  if (afterChecks.trim()) {
    throw new Error("Quality checks changed the working tree; promotion stopped");
  }
  const stillHead = (await runCommand("git", ["rev-parse", "HEAD"])).stdout.trim().toLowerCase();
  if (stillHead !== revision) {
    throw new Error("HEAD changed while promotion checks were running");
  }

  await runCommand("git", ["push", "origin", "HEAD:refs/heads/prod"]);
  return revision;
}

if (import.meta.main) {
  const revision = await promote();
  console.log(`[cinba] promoted ${revision} to prod`);
}
