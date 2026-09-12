import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeRevision } from "./health.ts";

type ReadRevision = (releaseRoot: string) => string;

function defaultReadRevision(releaseRoot: string): string {
  return execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: releaseRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
}

export function resolveServiceRevision(
  releaseRoot: string,
  readRevision: ReadRevision = defaultReadRevision,
): string {
  const revision = normalizeRevision(readRevision(releaseRoot).trim());
  if (revision === "unknown") {
    throw new Error("Service release did not resolve to a full Git revision");
  }
  return revision;
}

function currentReleaseRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export async function startReleaseService(releaseRoot = currentReleaseRoot()): Promise<void> {
  process.env.CINBA_REVISION = resolveServiceRevision(releaseRoot);
  const { startService } = await import("./index.ts");
  startService();
}

if (import.meta.main) {
  await startReleaseService();
}
