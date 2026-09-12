import { homedir } from "node:os";
import { deploymentConfig } from "./deployment-config.ts";
import { runDeployment } from "./run-deployment.ts";

export async function runDeploymentCli(homeDirectory = homedir()): Promise<number> {
  const result = await runDeployment(deploymentConfig(homeDirectory));
  switch (result.kind) {
    case "up_to_date":
    case "quarantined":
      return 0;
    case "succeeded":
      console.log(`[cinba-deploy] deployed ${result.targetRevision}`);
      return 0;
    case "rolled_back":
      console.error(
        `[cinba-deploy] rolled back ${result.targetRevision} after ${result.failure} failed`,
        result.cause,
      );
      return 1;
    case "failed":
      console.error(
        `[cinba-deploy] ${result.failure} failed${result.targetRevision ? ` for ${result.targetRevision}` : ""}`,
        result.cause,
      );
      return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runDeploymentCli();
}
