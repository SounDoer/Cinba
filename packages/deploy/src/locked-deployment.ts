import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deploymentConfig } from "./deployment-config.ts";
import { runWithDeploymentLock } from "./deployment-lock.ts";

export async function runLockedDeployment(homeDirectory = homedir()): Promise<void> {
  const config = deploymentConfig(homeDirectory);
  const scriptPath = fileURLToPath(new URL("./deployment-cli.ts", import.meta.url));
  await mkdir(dirname(config.lockPath), { recursive: true });
  await runWithDeploymentLock({ lockPath: config.lockPath, scriptPath });
}

if (import.meta.main) {
  await runLockedDeployment();
}
