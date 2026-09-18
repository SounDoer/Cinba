import { homedir } from "node:os";
import {
  installProductBundle,
  requireProductTarget,
  resolveInstalledProductCommand,
  resolveProductPaths,
  runInstalledProductCommand,
} from "@cinba/installer";
import { parseStableLauncherCommand } from "./product-launcher-command.ts";

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
  const launcherCommand = parseStableLauncherCommand(process.argv.slice(2), process.execPath);
  if (launcherCommand.type === "install") {
    if (platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0) {
      throw new Error("Cinba must be installed as a non-root user");
    }
    const transaction = await installProductBundle({
      bundleDirectory: launcherCommand.bundleDirectory,
      paths,
      target,
    });
    console.log(`Cinba ${transaction.candidate.version} installed successfully.`);
    return;
  }
  const command = await resolveInstalledProductCommand({
    layout: paths,
    target,
    arguments: launcherCommand.arguments,
  });
  process.exitCode = await runInstalledProductCommand(command);
}

run().catch((error: unknown) => {
  console.error(`[cinba] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
