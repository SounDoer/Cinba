import { spawn } from "node:child_process";
import type { InstalledProductLauncher } from "@cinba/installer";
import type { Choice } from "./settings-components.ts";
import {
  MAX_ERROR_LENGTH,
  TUI_HANDOFF_TIMEOUT_MS,
  type TuiUpdateChildOptions,
  type TuiUpdateConfirmation,
  type TuiUpdateHandoffController,
  runTuiUpdateChild,
} from "./tui-update.ts";

/** The same phrase `cinba uninstall --purge` asks for in a terminal. */
export const TUI_PURGE_CONFIRMATION = "DELETE ALL CINBA DATA";

export class TuiUninstallHandoffTimeoutError extends Error {
  override name = "TuiUninstallHandoffTimeoutError";
}

const CHOICES: Choice[] = [
  {
    value: "normal",
    label: "Uninstall Cinba",
    description: "keep sessions, settings, credentials, and Sync data",
  },
  {
    value: "purge",
    label: "Uninstall and delete all data",
    description: "permanently delete all Cinba data",
  },
];

export function launchTuiUninstallHandoff(
  executable: string,
  arguments_: readonly string[],
  options: TuiUpdateChildOptions = {},
  spawnProcess: typeof spawn = spawn,
): Promise<void> {
  return runTuiUpdateChild(
    executable,
    arguments_,
    ["ignore", "ignore", "pipe"],
    TUI_HANDOFF_TIMEOUT_MS,
    "uninstall handoff",
    (milliseconds) =>
      new TuiUninstallHandoffTimeoutError(
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

export function createTuiUninstall(options: {
  launcher: InstalledProductLauncher | undefined;
  isBusy: () => boolean;
  isCompacting: () => boolean;
  choose: (title: string, choices: Choice[]) => Promise<string | undefined>;
  confirm: (confirmation: TuiUpdateConfirmation) => Promise<boolean>;
  askText: (label: string) => Promise<string | undefined>;
  handoffController: TuiUpdateHandoffController;
  stopObserver: () => void;
  restartObserver: () => void;
  signal?: AbortSignal;
  launch: (executable: string, arguments_: readonly string[], signal: AbortSignal) => Promise<void>;
  exit: () => void;
  showNotice: (message: string) => void;
}): () => Promise<void> {
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
      const launcher = options.launcher;
      if (!launcher) {
        options.showNotice("Cinba can be uninstalled here only from an installed Cinba TUI.");
        return;
      }
      if (options.isBusy() || options.isCompacting()) {
        options.showNotice(
          "Wait for the current answer or context compaction to finish before uninstalling.",
        );
        return;
      }
      const mode = await options.choose("Uninstall Cinba", CHOICES);
      if (mode !== "normal" && mode !== "purge") {
        return;
      }
      const confirmed = await options.confirm(
        mode === "normal"
          ? {
              title: "Uninstall Cinba",
              message:
                "Cinba TUI will exit, this computer's Core and Sync will stop, and the Cinba programs will be removed. Sessions, settings, credentials, Pi data, and Sync data are kept, so reinstalling Cinba restores them.",
              positive: "Uninstall",
              negative: "Cancel",
              defaultConfirmed: false,
            }
          : {
              title: "Uninstall Cinba and Delete All Data",
              message:
                "Besides removing Cinba, this permanently deletes sessions, settings, credentials, Cinba's Pi data, and this computer's Sync authority. It cannot be undone. Your projects are not touched.",
              positive: "Continue",
              negative: "Cancel",
              defaultConfirmed: false,
            },
      );
      if (!confirmed) {
        return;
      }
      if (mode === "purge") {
        const typed = await options.askText(
          `Type "${TUI_PURGE_CONFIRMATION}" to permanently delete all Cinba data`,
        );
        if (typed !== TUI_PURGE_CONFIRMATION) {
          options.showNotice("Cinba purge cancelled; nothing was removed.");
          return;
        }
      }
      const handoff = options.handoffController.begin("uninstall");
      const handoffSignal = options.signal
        ? AbortSignal.any([options.signal, handoff.signal])
        : handoff.signal;
      try {
        options.stopObserver();
        // The launcher refuses active Core work and stops the services; its detached helper waits
        // for the top launcher of this TUI to exit before removing anything.
        await options.launch(
          launcher.path,
          ["__begin-uninstall", "tui", String(launcher.processId), mode],
          handoffSignal,
        );
      } catch (error) {
        if (options.signal?.aborted) {
          return;
        }
        if (error instanceof TuiUninstallHandoffTimeoutError) {
          options.showNotice(
            "The uninstall handoff timed out with an uncertain result. Cinba TUI will exit.",
          );
          options.exit();
          return;
        }
        options.restartObserver();
        options.showNotice(error instanceof Error ? error.message : String(error));
        return;
      } finally {
        handoff.finish();
      }
      handedOff = true;
      options.exit();
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
