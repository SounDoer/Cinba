import { spawn } from "node:child_process";
import type { InstalledProductLauncher } from "@cinba/installer";
import {
  type ProductUpdateReadiness,
  type ProductUpdateViewModel,
  parseProductUpdateReadinessJson,
} from "@cinba/product-runtime/automatic-update";

const MAX_ERROR_LENGTH = 2_048;
const MAX_CAPTURE_LENGTH = 4_096;
export const TUI_READINESS_TIMEOUT_MS = 10_000;
export const TUI_HANDOFF_TIMEOUT_MS = 60_000;
const TUI_TERMINATION_GRACE_MS = 250;

type TuiUpdateChildOptions = {
  signal?: AbortSignal;
  timeoutMilliseconds?: number;
  terminationGraceMilliseconds?: number;
};

type TuiUpdateChildResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutExceeded: boolean;
};

function runTuiUpdateChild(
  executable: string,
  arguments_: readonly string[],
  stdio: "ignore" | ["ignore", "pipe", "pipe"] | ["ignore", "ignore", "pipe"],
  timeoutMilliseconds: number,
  timeoutLabel: string,
  timeoutError: (milliseconds: number) => Error,
  options: TuiUpdateChildOptions,
  spawnProcess: typeof spawn,
): Promise<TuiUpdateChildResult> {
  return new Promise<TuiUpdateChildResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let stdoutExceeded = false;
    let settled = false;
    let terminationError: Error | undefined;
    const child = spawnProcess(executable, [...arguments_], {
      shell: false,
      stdio,
      windowsHide: true,
    });
    const capture = (
      current: string,
      chunk: Buffer | string,
    ): { value: string; exceeded: boolean } => {
      const combined = `${current}${String(chunk)}`;
      return {
        value: combined.slice(-MAX_CAPTURE_LENGTH),
        exceeded: combined.length > MAX_CAPTURE_LENGTH,
      };
    };
    const onStdout = (chunk: Buffer | string): void => {
      const captured = capture(stdout, chunk);
      stdout = captured.value;
      stdoutExceeded ||= captured.exceeded;
    };
    const onStderr = (chunk: Buffer | string): void => {
      stderr = capture(stderr, chunk).value;
    };
    const actualTimeoutMilliseconds = options.timeoutMilliseconds ?? timeoutMilliseconds;
    const terminationGraceMilliseconds =
      options.terminationGraceMilliseconds ?? TUI_TERMINATION_GRACE_MS;
    let timer: NodeJS.Timeout | undefined;
    let terminationTimer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      if (terminationTimer) {
        clearTimeout(terminationTimer);
      }
      options.signal?.removeEventListener("abort", onAbort);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
      child.unref?.();
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const onError = (error: Error): void => {
      rejectOnce(terminationError ?? error);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (terminationError) {
        rejectOnce(terminationError);
        return;
      }
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({ code, signal, stdout, stderr, stdoutExceeded });
    };
    const terminate = (error: Error): void => {
      if (settled || terminationError) {
        return;
      }
      terminationError = error;
      let terminated = false;
      try {
        terminated = child.kill("SIGTERM");
      } catch {
        // Force termination below. A thrown kill must not leave this promise pending.
      }
      if (!terminated) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The bounded rejection below is authoritative even when Windows reports kill failure.
        }
        rejectOnce(error);
        return;
      }
      terminationTimer = setTimeout(() => {
        try {
          // Node maps SIGKILL to TerminateProcess on Windows.
          child.kill("SIGKILL");
        } catch {
          // The process outcome is uncertain, but the caller must still settle in bounded time.
        }
        rejectOnce(error);
      }, terminationGraceMilliseconds);
    };
    const onAbort = (): void => {
      terminate(new Error(`Cinba ${timeoutLabel} was cancelled`));
    };

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    timer = setTimeout(
      () => terminate(timeoutError(actualTimeoutMilliseconds)),
      actualTimeoutMilliseconds,
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }
  });
}

export class TuiUpdateHandoffTimeoutError extends Error {
  override name = "TuiUpdateHandoffTimeoutError";
}

export class TuiUpdateHandoffController {
  #active: AbortController | undefined;
  #blockedInteractionNoticeShown = false;

  get inProgress(): boolean {
    return this.#active !== undefined;
  }

  begin(): { signal: AbortSignal; finish: () => void } {
    if (this.#active) {
      throw new Error("TUI update handoff is already in progress");
    }
    const controller = new AbortController();
    this.#active = controller;
    this.#blockedInteractionNoticeShown = false;
    return {
      signal: controller.signal,
      finish: () => {
        if (this.#active === controller) {
          this.#active = undefined;
          this.#blockedInteractionNoticeShown = false;
        }
      },
    };
  }

  blockInteraction(showNotice: (message: string) => void): boolean {
    if (!this.#active) {
      return false;
    }
    if (!this.#blockedInteractionNoticeShown) {
      this.#blockedInteractionNoticeShown = true;
      showNotice("Preparing update handoff…");
    }
    return true;
  }
}

function denyTuiRemoteRequestDuringHandoff(
  controller: TuiUpdateHandoffController,
  requestId: string,
  respond: (requestId: string, confirmed: boolean) => void,
  showNotice: (message: string) => void,
  requestName: string,
): boolean {
  if (!controller.inProgress) {
    return false;
  }
  respond(requestId, false);
  showNotice(`${requestName} was denied while the update handoff was in progress.`);
  return true;
}

export function denyTuiPermissionDuringHandoff(
  controller: TuiUpdateHandoffController,
  requestId: string,
  respond: (requestId: string, confirmed: boolean) => void,
  showNotice: (message: string) => void,
): boolean {
  return denyTuiRemoteRequestDuringHandoff(
    controller,
    requestId,
    respond,
    showNotice,
    "A permission request",
  );
}

export function denyTuiProjectTrustDuringHandoff(
  controller: TuiUpdateHandoffController,
  requestId: string,
  respond: (requestId: string, trusted: boolean) => void,
  showNotice: (message: string) => void,
): boolean {
  return denyTuiRemoteRequestDuringHandoff(
    controller,
    requestId,
    respond,
    showNotice,
    "A project trust request",
  );
}

export function blockTuiCoreInteractionDuringHandoff(
  controller: TuiUpdateHandoffController,
  showNotice: (message: string) => void,
): boolean {
  return controller.blockInteraction(showNotice);
}

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

export function createTuiReadinessPrompt(message: string): TuiUpdateConfirmation {
  return {
    title: "Update Waiting",
    message,
    positive: "Check Again",
    negative: "Later",
    defaultConfirmed: false,
  };
}

export function checkTuiUpdateReadiness(
  executable: string,
  version: string,
  options: TuiUpdateChildOptions = {},
  spawnProcess: typeof spawn = spawn,
): Promise<ProductUpdateReadiness> {
  return runTuiUpdateChild(
    executable,
    ["__check-update-readiness", version],
    ["ignore", "pipe", "pipe"],
    TUI_READINESS_TIMEOUT_MS,
    "update readiness check",
    (milliseconds) =>
      new Error(`Cinba update readiness check timed out after ${String(milliseconds)}ms`),
    options,
    spawnProcess,
  ).then(({ code, signal, stdout, stderr, stdoutExceeded }) => {
    if (code !== 0) {
      const outcome =
        code === null
          ? `exited on signal ${signal ?? "unknown"}`
          : `exited with code ${String(code)}`;
      const detail = stderr.trim();
      throw new Error(
        `Cinba update readiness check ${outcome}${detail ? `: ${detail}` : ""}`.slice(
          0,
          MAX_ERROR_LENGTH,
        ),
      );
    }
    if (stdoutExceeded) {
      throw new Error("Cinba update readiness output exceeded the allowed length");
    }
    const lines = stdout.endsWith("\n")
      ? stdout.slice(0, -1).split(/\r?\n/)
      : stdout.split(/\r?\n/);
    if (lines.length !== 1 || !lines[0]) {
      throw new Error("Cinba update readiness output must contain exactly one JSON line");
    }
    try {
      return parseProductUpdateReadinessJson(lines[0]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Cinba update readiness check failed: ${detail}`.slice(0, MAX_ERROR_LENGTH), {
        cause: error,
      });
    }
  });
}

export function launchTuiUpdateHandoff(
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
    "update handoff",
    (milliseconds) =>
      new TuiUpdateHandoffTimeoutError(
        `Cinba update handoff timed out after ${String(milliseconds)}ms`,
      ),
    options,
    spawnProcess,
  ).then(({ code, signal, stderr }) => {
    if (code !== 0) {
      const outcome =
        code === null
          ? `exited on signal ${signal ?? "unknown"}`
          : `exited with code ${String(code)}`;
      const detail = stderr.trim();
      throw new Error(
        `Cinba update handoff ${outcome}${detail ? `: ${detail}` : ""}`.slice(0, MAX_ERROR_LENGTH),
      );
    }
  });
}

type TuiInstallReadyUpdateOptions = {
  launcher: InstalledProductLauncher | undefined;
  workingDirectory: string;
  getUpdate: () => ProductUpdateViewModel | undefined;
  isBusy: () => boolean;
  isCompacting: () => boolean;
  confirm: (confirmation: TuiUpdateConfirmation) => Promise<boolean>;
  signal?: AbortSignal;
  checkReadiness: (
    executable: string,
    version: string,
    signal: AbortSignal,
  ) => Promise<ProductUpdateReadiness>;
  promptReadiness: (confirmation: TuiUpdateConfirmation, signal: AbortSignal) => Promise<boolean>;
  ownReadinessWait: (cancel: () => void) => () => boolean;
  handoffController: TuiUpdateHandoffController;
  stopObserver: () => void;
  restartObserver: () => void;
  launch: (executable: string, arguments_: readonly string[], signal: AbortSignal) => Promise<void>;
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
      const version = update.candidateVersion;
      const waitController = new AbortController();
      const waitSignal = options.signal
        ? AbortSignal.any([options.signal, waitController.signal])
        : waitController.signal;
      const releaseWait = options.ownReadinessWait(() => waitController.abort());
      try {
        while (true) {
          const current = options.getUpdate();
          if (current?.phase !== "ready" || current.candidateVersion !== version) {
            options.showNotice(
              `Cinba update candidate changed from ${version}; no update was installed.`,
            );
            return;
          }
          let readiness: ProductUpdateReadiness;
          try {
            readiness = await options.checkReadiness(options.launcher.path, version, waitSignal);
          } catch (error) {
            if (waitSignal.aborted) {
              return;
            }
            const detail = error instanceof Error ? error.message : String(error);
            options.showNotice(
              `Cinba could not check update readiness: ${detail}`.slice(0, MAX_ERROR_LENGTH),
            );
            return;
          }
          if (readiness.status === "waiting") {
            if (
              await options.promptReadiness(createTuiReadinessPrompt(readiness.message), waitSignal)
            ) {
              continue;
            }
            return;
          }
          const checked = options.getUpdate();
          if (checked?.phase !== "ready" || checked.candidateVersion !== version) {
            options.showNotice(
              `Cinba update candidate changed from ${version}; no update was installed.`,
            );
            return;
          }
          break;
        }
      } finally {
        releaseWait();
        waitController.abort();
      }
      const handoff = options.handoffController.begin();
      const handoffSignal = options.signal
        ? AbortSignal.any([options.signal, handoff.signal])
        : handoff.signal;
      try {
        options.stopObserver();
        await options.launch(
          options.launcher.path,
          [
            "__begin-update-handoff",
            "tui",
            String(options.launcher.processId),
            version,
            options.workingDirectory,
          ],
          handoffSignal,
        );
      } catch (error) {
        if (options.signal?.aborted) {
          return;
        }
        if (error instanceof TuiUpdateHandoffTimeoutError) {
          options.showNotice(
            "The update handoff timed out with an uncertain result. Restart Cinba before continuing.",
          );
          // The helper may have accepted the handoff before becoming unresponsive. Exiting keeps
          // this blocking TUI from accepting new Core work while that outcome is unresolved.
          options.exit();
          return;
        }
        options.restartObserver();
        const detail = error instanceof Error ? error.message : String(error);
        options.showNotice(
          `Cinba could not start the update: ${detail}`.slice(0, MAX_ERROR_LENGTH),
        );
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
