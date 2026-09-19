import { spawn } from "node:child_process";
import {
  DESKTOP_HANDOFF_TIMEOUT_MS,
  type DesktopUpdateChildOptions,
  MAX_ERROR_LENGTH,
  runDesktopUpdateChild,
} from "./desktop-update.ts";

export type DesktopUninstallMode = "normal" | "purge";

export class DesktopUninstallHandoffTimeoutError extends Error {
  override name = "DesktopUninstallHandoffTimeoutError";
}

export type DesktopUninstallDialog = {
  type: "warning";
  title: string;
  message: string;
  detail: string;
  buttons: [string, "Cancel"];
  defaultId: 1;
  cancelId: 1;
  noLink: true;
  checkboxLabel?: string;
  checkboxChecked?: false;
};

/** Normal uninstall asks once; purge asks twice and needs an explicit acknowledgement. */
export function createDesktopUninstallDialogs(
  mode: DesktopUninstallMode,
): DesktopUninstallDialog[] {
  const common = { type: "warning", defaultId: 1, cancelId: 1, noLink: true } as const;
  if (mode === "normal") {
    return [
      {
        ...common,
        title: "Uninstall Cinba",
        message: "Uninstall Cinba from this computer?",
        detail:
          "Cinba Desktop will quit, this computer's Core and Sync will stop, and the Cinba programs will be removed. Sessions, settings, credentials, Core profiles, Pi data, and Sync data are kept, so reinstalling Cinba restores them.",
        buttons: ["Uninstall", "Cancel"],
      },
    ];
  }
  return [
    {
      ...common,
      title: "Uninstall Cinba and Delete All Data",
      message: "Permanently delete all Cinba data?",
      detail:
        "Besides removing Cinba, this deletes sessions, settings, credentials, Core profiles, Cinba's Pi data, and this computer's Sync authority. Your projects are not touched.",
      buttons: ["Continue…", "Cancel"],
    },
    {
      ...common,
      title: "Uninstall Cinba and Delete All Data",
      message: "This cannot be undone.",
      detail: "Cinba Desktop will quit, then Cinba and all Cinba data will be removed.",
      checkboxLabel: "I understand that all Cinba data will be permanently deleted",
      checkboxChecked: false,
      buttons: ["Delete All Data and Uninstall", "Cancel"],
    },
  ];
}

export async function confirmDesktopUninstall(
  mode: DesktopUninstallMode,
  show: (dialog: DesktopUninstallDialog) => Promise<{ response: number; checkboxChecked: boolean }>,
): Promise<boolean> {
  for (const dialog of createDesktopUninstallDialogs(mode)) {
    const result = await show(dialog);
    if (result.response !== 0 || (dialog.checkboxLabel !== undefined && !result.checkboxChecked)) {
      return false;
    }
  }
  return true;
}

export function launchDesktopUninstallHandoff(
  executable: string,
  arguments_: readonly string[],
  options: DesktopUpdateChildOptions = {},
  spawnProcess: typeof spawn = spawn,
): Promise<void> {
  return runDesktopUpdateChild(
    executable,
    arguments_,
    ["ignore", "pipe", "pipe"],
    DESKTOP_HANDOFF_TIMEOUT_MS,
    "uninstall handoff",
    (milliseconds) =>
      new DesktopUninstallHandoffTimeoutError(
        `Cinba uninstall handoff timed out after ${String(milliseconds)}ms`,
      ),
    options,
    spawnProcess,
  ).then(({ code, signal, stderr }) => {
    if (code !== 0) {
      // The launcher explains a refusal, such as active Core work, on its last stderr line.
      const reason = stderr
        .trim()
        .split(/\r?\n/)
        .at(-1)
        ?.replace(/^\[cinba\] /, "");
      throw new Error(
        (
          reason ||
          (code === null
            ? `Cinba uninstall handoff exited on signal ${signal ?? "unknown"}`
            : `Cinba uninstall handoff exited with code ${code}`)
        ).slice(0, MAX_ERROR_LENGTH),
      );
    }
  });
}

export function createDesktopUninstall(options: {
  identity: "development" | "release";
  launcherPath: string;
  processId: number;
  signal?: AbortSignal;
  confirm: (mode: DesktopUninstallMode) => Promise<boolean>;
  launch: (executable: string, arguments_: readonly string[]) => Promise<void>;
  quit: () => void;
  showError: (message: string) => Promise<void>;
}): (mode: DesktopUninstallMode) => Promise<void> {
  let inFlight: Promise<void> | undefined;
  let handedOff = false;

  return (mode) => {
    if (handedOff) {
      return Promise.resolve();
    }
    if (inFlight) {
      return inFlight;
    }
    inFlight = (async () => {
      if (options.identity !== "release") {
        await options.showError("Uninstall is available only in the installed Cinba Desktop.");
        return;
      }
      if (!(await options.confirm(mode))) {
        return;
      }
      try {
        // The launcher refuses active Core work and stops the services; its detached helper waits
        // for this Desktop to exit before removing anything, so Desktop quits itself afterwards.
        await options.launch(options.launcherPath, [
          "__begin-uninstall",
          "desktop",
          String(options.processId),
          mode,
        ]);
      } catch (error) {
        if (options.signal?.aborted) {
          return;
        }
        if (error instanceof DesktopUninstallHandoffTimeoutError) {
          await options.showError(
            "The uninstall handoff timed out with an uncertain result. Cinba will quit.",
          );
          options.quit();
          return;
        }
        await options.showError(error instanceof Error ? error.message : String(error));
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
