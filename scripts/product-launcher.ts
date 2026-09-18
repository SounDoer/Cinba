import { homedir } from "node:os";
import {
  configurePosixLauncherPath,
  configureWindowsUserPath,
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
    if (platform === "win32") {
      try {
        const pathResult = await configureWindowsUserPath({
          launcherDirectory: paths.launcherDirectory,
        });
        if (pathResult === "updated") {
          console.log("Open a new terminal to use cinba.");
        }
      } catch (error) {
        console.warn(
          `[cinba] Cinba was installed, but PATH was not changed: ${error instanceof Error ? error.message : String(error)}`,
        );
        console.warn(`Add ${paths.launcherDirectory} to PATH manually.`);
      }
    } else {
      try {
        const pathConfiguration = await configurePosixLauncherPath({
          homeDirectory: homedir(),
          launcherDirectory: paths.launcherDirectory,
          currentPath: process.env.PATH ?? "",
          shell: process.env.SHELL ?? "",
        });
        if (pathConfiguration.state === "profile-updated") {
          console.log(
            `Restart your shell or source ${pathConfiguration.profilePath} to use cinba.`,
          );
        } else if (pathConfiguration.state === "manual") {
          console.log(pathConfiguration.instruction);
        }
      } catch (error) {
        console.warn(
          `[cinba] Cinba was installed, but PATH was not changed: ${error instanceof Error ? error.message : String(error)}`,
        );
        console.warn(`Add ${paths.launcherDirectory} to PATH manually.`);
      }
    }
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
