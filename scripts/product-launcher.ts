import { homedir } from "node:os";
import {
  requireProductTarget,
  resolveInstalledProductCommand,
  resolveProductPaths,
  runInstalledProductCommand,
} from "@cinba/installer";

async function run(): Promise<void> {
  const target = requireProductTarget();
  const platform = process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`Cinba is not available on ${platform}`);
  }
  const paths = resolveProductPaths({
    platform,
    homeDirectory: homedir(),
    environment: process.env,
  });
  const command = await resolveInstalledProductCommand({
    layout: paths,
    target,
    arguments: process.argv.slice(2),
  });
  process.exitCode = await runInstalledProductCommand(command);
}

run().catch((error: unknown) => {
  console.error(`[cinba] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
