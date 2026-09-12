import { spawn } from "node:child_process";

type GitResult = { exitCode: number; stdout: string };

function validateRevision(value: string, name: string): string {
  const revision = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error(`${name} is not a full Git revision`);
  }
  return revision;
}

function runGit(repoPath: string, args: string[], allowedExitCodes = [0]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: repoPath,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.resume();
    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      const exitCode = code ?? -1;
      if (!allowedExitCodes.includes(exitCode)) {
        reject(new Error(`git ${args[0] ?? "command"} failed with exit code ${exitCode}`));
        return;
      }
      resolve({ exitCode, stdout });
    });
  });
}

/** Fetch exactly the deployment branch and return the commit it names. */
export async function fetchProdRevision(repoPath: string): Promise<string> {
  await runGit(repoPath, [
    "fetch",
    "--quiet",
    "origin",
    "+refs/heads/prod:refs/remotes/origin/prod",
  ]);
  const result = await runGit(repoPath, [
    "rev-parse",
    "--verify",
    "refs/remotes/origin/prod^{commit}",
  ]);
  return validateRevision(result.stdout, "origin/prod");
}

/** A return value of false means prod moved backward or onto unrelated history. */
export async function isFastForward(
  repoPath: string,
  runningRevision: string,
  targetRevision: string,
): Promise<boolean> {
  const running = validateRevision(runningRevision, "runningRevision");
  const target = validateRevision(targetRevision, "targetRevision");
  const result = await runGit(repoPath, ["merge-base", "--is-ancestor", running, target], [0, 1]);
  return result.exitCode === 0;
}
