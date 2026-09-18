import { spawn } from "node:child_process";
import { homedir } from "node:os";
import {
  configurePosixLauncherPath,
  configureWindowsProductIntegration,
  configureWindowsUserPath,
  installProductBundle,
  requireProductTarget,
  resolveInstalledProductCommand,
  resolveProductPaths,
  runInstalledProductCommand,
} from "@cinba/installer";
import { parseStableLauncherCommand } from "./product-launcher-command.ts";
import {
  MACOS_INSTALL_PARENT_PROCESS_ID,
  parseMacosInstallHandoff,
  waitForMacosInstallerExit,
} from "./macos-install-handoff.ts";
import {
  confirmPurge,
  launchUninstallHelper,
  runUninstallHelper,
  stopProductForUninstall,
} from "./product-uninstall.ts";

function openMacosApplication(applicationPath: string): void {
  const child = spawn("/usr/bin/open", [applicationPath], {
    detached: true,
    stdio: "ignore",
  });
  child.once("error", () => {});
  child.unref();
}

function showMacosInstallationFailure(): void {
  const child = spawn(
    "/usr/bin/osascript",
    [
      "-e",
      'display alert "Cinba installation failed" message "Please download the installer again or inspect the installation log in Library/Logs/com.soundoer.cinba." as critical',
    ],
    { detached: true, stdio: "ignore" },
  );
  child.once("error", () => {});
  child.unref();
}

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
  if (launcherCommand.type === "uninstall-helper") {
    await runUninstallHelper(launcherCommand);
    return;
  }
  if (launcherCommand.type === "uninstall") {
    if (launcherCommand.purge && !launcherCommand.deleteAllCinbaData) {
      await confirmPurge();
    }
    await stopProductForUninstall();
    await launchUninstallHelper({ purge: launcherCommand.purge });
    console.log("Cinba uninstall started.");
    return;
  }
  if (launcherCommand.type === "install") {
    const macosHandoff = parseMacosInstallHandoff(process.env);
    if (macosHandoff) {
      if (platform !== "darwin") {
        throw new Error("the macOS installer handoff is available only on macOS");
      }
      await waitForMacosInstallerExit(macosHandoff);
    }
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
      if (!paths.desktopApplicationPath) {
        throw new Error("Windows installation paths do not include Cinba Desktop");
      }
      try {
        await configureWindowsProductIntegration({
          programDirectory: paths.programDirectory,
          launcherPath: paths.launcherPath,
          desktopApplicationPath: paths.desktopApplicationPath,
          version: transaction.candidate.version,
        });
      } catch (error) {
        console.warn(
          `[cinba] Cinba was installed, but Windows app registration failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
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
    if (macosHandoff) {
      if (!paths.desktopApplicationPath) {
        throw new Error("macOS installation paths do not include Cinba Desktop");
      }
      openMacosApplication(paths.desktopApplicationPath);
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
  if (process.platform === "darwin" && process.env[MACOS_INSTALL_PARENT_PROCESS_ID]) {
    showMacosInstallationFailure();
  }
  process.exitCode = 1;
});
