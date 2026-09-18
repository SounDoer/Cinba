import { spawn } from "node:child_process";
import type { InstalledProductLauncher } from "@cinba/installer";
import type { ProductUpdateViewModel } from "@cinba/product-runtime";

const MAX_ERROR_LENGTH = 2_048;
const MAX_STDERR_LENGTH = 1_024;

export type TuiUpdateConfirmation = {
  title: string;
  message: string;
  positive: string;
  negative: string;
  defaultConfirmed: false;
};

export function createTuiUpdateConfirmation(
  version: string,
  workingDirectory: string,
): TuiUpdateConfirmation {
  return {
    title: `Install Cinba ${version}`,
    message: `Cinba TUI and this computer's Core and Sync will stop safely. After the update, Cinba TUI will reopen in ${workingDirectory}.`,
    positive: "Install and Restart",
    negative: "Later",
    defaultConfirmed: false,
  };
}

export function launchTuiUpdateHandoff(
  executable: string,
  arguments_: readonly string[],
  spawnProcess: typeof spawn = spawn,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stderr = "";
    const child = spawnProcess(executable, [...arguments_], {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${String(chunk)}`.slice(-MAX_STDERR_LENGTH);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const outcome =
        code === null
          ? `exited on signal ${signal ?? "unknown"}`
          : `exited with code ${String(code)}`;
      const detail = stderr.trim();
      reject(
        new Error(
          `Cinba update handoff ${outcome}${detail ? `: ${detail}` : ""}`.slice(
            0,
            MAX_ERROR_LENGTH,
          ),
        ),
      );
    });
  });
}

type TuiInstallReadyUpdateOptions = {
  launcher: InstalledProductLauncher | undefined;
  workingDirectory: string;
  getUpdate: () => ProductUpdateViewModel | undefined;
  isBusy: () => boolean;
  isCompacting: () => boolean;
  confirm: (confirmation: TuiUpdateConfirmation) => Promise<boolean>;
  stopObserver: () => void;
  restartObserver: () => void;
  launch: (executable: string, arguments_: readonly string[]) => Promise<void>;
  exit: () => void;
  showNotice: (message: string) => void;
};

export function createTuiInstallReadyUpdate(
  options: TuiInstallReadyUpdateOptions,
): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  let handedOff = false;

  return () => {
    if (handedOff) {
      return Promise.resolve();
    }
    if (inFlight) {
      return inFlight;
    }
    inFlight = (async () => {
      if (!options.launcher) {
        options.showNotice("Updates can be installed here only from an installed Cinba TUI.");
        return;
      }
      const update = options.getUpdate();
      if (update?.phase !== "ready") {
        options.showNotice("No ready Cinba update is available.");
        return;
      }
      if (options.isBusy() || options.isCompacting()) {
        options.showNotice(
          "Wait for the current answer or context compaction to finish before installing the update.",
        );
        return;
      }
      const confirmed = await options.confirm(
        createTuiUpdateConfirmation(update.candidateVersion, options.workingDirectory),
      );
      if (!confirmed) {
        return;
      }
      const confirmedUpdate = options.getUpdate();
      if (
        confirmedUpdate?.phase !== "ready" ||
        confirmedUpdate.candidateVersion !== update.candidateVersion ||
        options.isBusy() ||
        options.isCompacting()
      ) {
        options.showNotice("The update is no longer ready to install. Please try /update again.");
        return;
      }
      options.stopObserver();
      try {
        await options.launch(options.launcher.path, [
          "__begin-update-handoff",
          "tui",
          String(options.launcher.processId),
          update.candidateVersion,
          options.workingDirectory,
        ]);
      } catch (error) {
        options.restartObserver();
        const detail = error instanceof Error ? error.message : String(error);
        options.showNotice(
          `Cinba could not start the update: ${detail}`.slice(0, MAX_ERROR_LENGTH),
        );
        return;
      }
      handedOff = true;
      options.exit();
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
