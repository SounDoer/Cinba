import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import {
  type ProductInstallationProgress,
  configurePosixLauncherPath,
  configureWindowsProductIntegration,
  configureWindowsUserPath,
  installProductBundle,
  requireProductTarget,
  resolveInstalledProductCommand,
  resolveProductPaths,
  runInstalledProductCommand,
} from "@cinba/installer";
import {
  parseExpectedProductInstallRelease,
  parseStableLauncherCommand,
} from "./product-launcher-command.ts";
import {
  MACOS_INSTALL_PARENT_PROCESS_ID,
  parseMacosInstallHandoff,
  waitForMacosInstallerExit,
} from "./macos-install-handoff.ts";
import {
  beginForegroundUninstall,
  confirmPurge,
  launchUninstallHelper,
  reportPreviousUninstallFailure,
  runUninstallHelper,
  stopProductForUninstall,
} from "./product-uninstall.ts";
import {
  beginForegroundUpdateHandoff,
  runProductUpdateReadinessCommand,
  runStableProductUpdate,
  runUpdateHandoffHelper,
} from "./product-update.ts";

const INSTALL_PROGRESS_MESSAGES: Record<ProductInstallationProgress, string> = {
  "waiting-for-lock": "Waiting for another Cinba installation or uninstall to finish.",
  "lock-released": "The other Cinba operation finished; continuing.",
  "checking-package": "Checking the Cinba package.",
  preparing: "Preparing the installation.",
  "copying-payload": "Copying program files.",
  activating: "Activating Cinba.",
  verifying: "Verifying the installed files.",
};

/** Where to record the final failure line for an installer that only sees this process' output. */
let installFailureLogPath: string | undefined;

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

async function confirmUpdateInstallation(version: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`Install Cinba ${version} now? [y/N] `);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    prompt.close();
  }
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
  if (launcherCommand.type === "update-handoff-helper") {
    await runUpdateHandoffHelper(launcherCommand);
    return;
  }
  if (launcherCommand.type === "check-update-readiness") {
    await runProductUpdateReadinessCommand({
      expectedVersion: launcherCommand.expectedVersion,
      target,
      paths,
    });
    return;
  }
  if (launcherCommand.type === "begin-update-handoff") {
    await beginForegroundUpdateHandoff({
      platform,
      paths,
      target,
      surface: launcherCommand.surface,
      blockingProcessId: launcherCommand.blockingProcessId,
      expectedVersion: launcherCommand.expectedVersion,
      ...(launcherCommand.surface === "tui"
        ? { workingDirectory: launcherCommand.workingDirectory }
        : {}),
    });
    return;
  }
  if (launcherCommand.type === "uninstall-helper") {
    await runUninstallHelper(launcherCommand);
    return;
  }
  if (launcherCommand.type === "begin-uninstall") {
    await beginForegroundUninstall(launcherCommand);
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
  if (launcherCommand.type === "update") {
    await runStableProductUpdate({
      platform,
      paths,
      target,
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      confirm: confirmUpdateInstallation,
    });
    return;
  }
  if (launcherCommand.type === "install") {
    installFailureLogPath = launcherCommand.failureLogPath;
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
    const expectedRelease = parseExpectedProductInstallRelease(process.env);
    const transaction = await installProductBundle({
      bundleDirectory: launcherCommand.bundleDirectory,
      paths,
      target,
      ...(expectedRelease ? { expectedRelease } : {}),
      ...(launcherCommand.consumeBundle ? { consumeBundle: true } : {}),
      report: (progress) => console.log(INSTALL_PROGRESS_MESSAGES[progress]),
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
  // A surface-initiated uninstall runs without output; tell the person here if it failed.
  if (process.stderr.isTTY) {
    await reportPreviousUninstallFailure(paths);
  }
  const command = await resolveInstalledProductCommand({
    layout: paths,
    target,
    arguments: launcherCommand.arguments,
  });
  process.exitCode = await runInstalledProductCommand(command);
}

run().catch((error: unknown) => {
  const message = `[cinba] ${error instanceof Error ? error.message : String(error)}`.slice(
    0,
    2_048,
  );
  console.error(message);
  if (installFailureLogPath) {
    try {
      writeFileSync(installFailureLogPath, message.slice(0, 1_024));
    } catch {
      // The installer falls back to its own message when this log is missing.
    }
  }
  if (process.platform === "darwin" && process.env[MACOS_INSTALL_PARENT_PROCESS_ID]) {
    showMacosInstallationFailure();
  }
  process.exitCode = 1;
});
