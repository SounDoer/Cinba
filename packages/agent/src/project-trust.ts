// Inspect and record the same project trust boundary Pi applies before loading resources.

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { ProjectTrustStore, getAgentDir } from "@earendil-works/pi-coding-agent";

const PI_PROJECT_RESOURCES = [
  "settings.json",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
] as const;

export type ProjectTrustInspection = {
  required: boolean;
  decision: boolean | null;
  resources: string[];
};

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = resolve(value);
    let canonical = resolved;
    try {
      canonical = realpathSync.native(resolved);
    } catch {
      // Missing paths cannot have aliases that need resolving.
    }
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  };
  return normalize(left) === normalize(right);
}

function displayPath(cwd: string, path: string): string {
  const value = relative(cwd, path) || ".";
  return value.replaceAll("\\", "/");
}

/** What made this directory require trust, without exposing unrelated files. */
export function inspectProjectTrust(cwd: string, agentDir = getAgentDir()): ProjectTrustInspection {
  const resolvedCwd = resolve(cwd);
  const resources: string[] = [];
  for (const entry of PI_PROJECT_RESOURCES) {
    const path = join(resolvedCwd, ".pi", entry);
    if (existsSync(path)) {
      resources.push(displayPath(resolvedCwd, path));
    }
  }

  // Pi deliberately prefers HOME when supplied, including in tests and service wrappers.
  const globalAgentsSkills = join(process.env.HOME || homedir(), ".agents", "skills");
  let current = resolvedCwd;
  while (true) {
    const path = join(current, ".agents", "skills");
    if (!samePath(path, globalAgentsSkills) && existsSync(path)) {
      resources.push(displayPath(resolvedCwd, path));
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  // Deriving this from the displayed resource list also avoids treating the
  // shared ~/.agents/skills directory as project-owned when Windows supplies
  // the cwd through an 8.3 short-path alias.
  const required = resources.length > 0;
  return {
    required,
    decision: required ? new ProjectTrustStore(agentDir).get(resolvedCwd) : null,
    resources: [...new Set(resources)],
  };
}

export function rememberProjectTrust(
  cwd: string,
  trusted: boolean,
  agentDir = getAgentDir(),
): void {
  new ProjectTrustStore(agentDir).set(resolve(cwd), trusted);
}
