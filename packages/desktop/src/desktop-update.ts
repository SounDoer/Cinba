import { spawn } from "node:child_process";
import type { ProductUpdateViewModel } from "@cinba/product-runtime";

export type DesktopUpdateConfirmation = {
  type: "info";
  title: string;
  message: string;
  detail: string;
  buttons: [string, string];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
};

export function createDesktopUpdateConfirmation(version: string): DesktopUpdateConfirmation {
  return {
    type: "info",
    title: `Install Cinba ${version}`,
    message: `Cinba ${version} is ready to install.`,
    detail:
      "Cinba Desktop and this computer's Core and Sync will stop safely, then Cinba will restart.",
    buttons: ["Install and Restart", "Later"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}

export function launchDesktopUpdateHandoff(
  executable: string,
  arguments_: readonly string[],
  spawnProcess: typeof spawn = spawn,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawnProcess(executable, [...arguments_], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          code === null
            ? `Cinba update handoff exited on signal ${signal ?? "unknown"}`
            : `Cinba update handoff exited with code ${code}`,
        ),
      );
    });
  });
}

type InstallReadyUpdateOptions = {
  identity: "development" | "release";
  launcherPath: string;
  processId: number;
  getUpdate: () => ProductUpdateViewModel | undefined;
  confirm: (version: string) => Promise<boolean>;
  abortAutomaticUpdate: () => void;
  resumeAutomaticUpdate: () => void;
  launch: (executable: string, arguments_: readonly string[]) => Promise<void>;
  quit: () => void;
  showError: (message: string) => Promise<void>;
};

function readyVersion(update: ProductUpdateViewModel | undefined): string {
  if (update?.phase !== "ready") {
    throw new Error("Desktop update installation requires a ready update");
  }
  return update.candidateVersion;
}

export function createDesktopInstallReadyUpdate(
  options: InstallReadyUpdateOptions,
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
      if (options.identity !== "release") {
        throw new Error("Update installation is available only in the release Desktop");
      }
      const version = readyVersion(options.getUpdate());
      if (!(await options.confirm(version))) {
        return;
      }
      if (readyVersion(options.getUpdate()) !== version) {
        throw new Error("Desktop ready update changed during confirmation");
      }
      options.abortAutomaticUpdate();
      try {
        await options.launch(options.launcherPath, [
          "__begin-update-handoff",
          "desktop",
          String(options.processId),
          version,
        ]);
      } catch (error) {
        options.resumeAutomaticUpdate();
        const detail = error instanceof Error ? error.message : String(error);
        await options.showError(`Cinba could not start the update: ${detail}`.slice(0, 2_048));
        return;
      }
      handedOff = true;
      options.quit();
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
