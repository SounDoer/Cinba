import { spawn } from "node:child_process";
import {
  type ProductUpdateReadiness,
  type ProductUpdateViewModel,
  parseProductUpdateReadinessJson,
} from "@cinba/product-runtime";

export const MAX_ERROR_LENGTH = 2_048;
const MAX_CAPTURE_LENGTH = 4_096;
export const DESKTOP_READINESS_TIMEOUT_MS = 10_000;
export const DESKTOP_HANDOFF_TIMEOUT_MS = 60_000;
const DESKTOP_TERMINATION_GRACE_MS = 250;

export type DesktopUpdateChildOptions = {
  signal?: AbortSignal;
  timeoutMilliseconds?: number;
  terminationGraceMilliseconds?: number;
};

type DesktopUpdateChildResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutExceeded: boolean;
};

export function runDesktopUpdateChild(
  executable: string,
  arguments_: readonly string[],
  stdio: "ignore" | ["ignore", "pipe", "pipe"],
  timeoutMilliseconds: number,
  timeoutLabel: string,
  timeoutError: (milliseconds: number) => Error,
  options: DesktopUpdateChildOptions,
  spawnProcess: typeof spawn,
): Promise<DesktopUpdateChildResult> {
  return new Promise<DesktopUpdateChildResult>((resolve, reject) => {
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
      options.terminationGraceMilliseconds ?? DESKTOP_TERMINATION_GRACE_MS;
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

export class DesktopUpdateHandoffTimeoutError extends Error {
  override name = "DesktopUpdateHandoffTimeoutError";
}

export type DesktopUpdateConfirmation = {
  type: "info" | "error";
  title: string;
  message: string;
  detail?: string;
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

export function createDesktopReadinessPrompt(
  message: string,
  error = false,
): DesktopUpdateConfirmation {
  return {
    type: error ? "error" : "info",
    title: error ? "Cinba Update Check Failed" : "Cinba Update Is Waiting",
    message,
    buttons: ["Check Again", "Later"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}

export function checkDesktopUpdateReadiness(
  executable: string,
  version: string,
  options: DesktopUpdateChildOptions = {},
  spawnProcess: typeof spawn = spawn,
): Promise<ProductUpdateReadiness> {
  return runDesktopUpdateChild(
    executable,
    ["__check-update-readiness", version],
    ["ignore", "pipe", "pipe"],
    DESKTOP_READINESS_TIMEOUT_MS,
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

export function launchDesktopUpdateHandoff(
  executable: string,
  arguments_: readonly string[],
  options: DesktopUpdateChildOptions = {},
  spawnProcess: typeof spawn = spawn,
): Promise<void> {
  return runDesktopUpdateChild(
    executable,
    arguments_,
    "ignore",
    DESKTOP_HANDOFF_TIMEOUT_MS,
    "update handoff",
    (milliseconds) =>
      new DesktopUpdateHandoffTimeoutError(
        `Cinba update handoff timed out after ${String(milliseconds)}ms`,
      ),
    options,
    spawnProcess,
  ).then(({ code, signal }) => {
    if (code !== 0) {
      throw new Error(
        code === null
          ? `Cinba update handoff exited on signal ${signal ?? "unknown"}`
          : `Cinba update handoff exited with code ${code}`,
      );
    }
  });
}

type InstallReadyUpdateOptions = {
  identity: "development" | "release";
  launcherPath: string;
  processId: number;
  getUpdate: () => ProductUpdateViewModel | undefined;
  confirm: (version: string) => Promise<boolean>;
  signal?: AbortSignal;
  checkReadiness: (executable: string, version: string) => Promise<ProductUpdateReadiness>;
  promptReadiness: (message: string, error: boolean) => Promise<boolean>;
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
      while (true) {
        const current = options.getUpdate();
        if (current?.phase !== "ready" || current.candidateVersion !== version) {
          await options.showError(
            `Cinba update candidate changed from ${version}; no update was installed.`,
          );
          return;
        }
        let readiness: ProductUpdateReadiness;
        try {
          readiness = await options.checkReadiness(options.launcherPath, version);
        } catch (error) {
          if (options.signal?.aborted) {
            return;
          }
          const detail = error instanceof Error ? error.message : String(error);
          const retry = await options.promptReadiness(
            `Cinba could not check update readiness: ${detail}`.slice(0, MAX_ERROR_LENGTH),
            true,
          );
          if (retry) {
            continue;
          }
          return;
        }
        if (readiness.status === "waiting") {
          if (await options.promptReadiness(readiness.message, false)) {
            continue;
          }
          return;
        }
        const checked = options.getUpdate();
        if (checked?.phase !== "ready" || checked.candidateVersion !== version) {
          await options.showError(
            `Cinba update candidate changed from ${version}; no update was installed.`,
          );
          return;
        }
        break;
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
        if (options.signal?.aborted) {
          return;
        }
        if (error instanceof DesktopUpdateHandoffTimeoutError) {
          await options.showError(
            "The update handoff timed out with an uncertain result. Restart Cinba before continuing.",
          );
          // The helper may already own the handoff. Quit instead of resuming new Core work while
          // the blocking Desktop PID could release at an arbitrary later point.
          options.quit();
          return;
        }
        options.resumeAutomaticUpdate();
        const detail = error instanceof Error ? error.message : String(error);
        await options.showError(
          `Cinba could not start the update: ${detail}`.slice(0, MAX_ERROR_LENGTH),
        );
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
