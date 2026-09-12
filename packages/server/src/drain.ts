export const DRAIN_TIMEOUT_MS = 15 * 60_000;

export type DrainStopMode = "safe" | "forced";

export type DrainController = {
  readonly draining: boolean;
  request(): void;
  check(): void;
  force(): void;
  wait(): Promise<void>;
};

export function canProcessDuringDrain(messageType: string): boolean {
  return messageType === "abort" || messageType === "respond_confirm";
}

export function createDrainController(options: {
  isSafe: () => boolean;
  stop: (mode: DrainStopMode) => void | Promise<void>;
  timeoutMs?: number;
  onStopped?: (error?: unknown) => void;
}): DrainController {
  let state: "accepting" | "draining" | "stopping" | "stopped" = "accepting";
  let deadline: NodeJS.Timeout | undefined;
  let resolveWait: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    resolveWait = resolve;
  });

  async function finish(mode: DrainStopMode): Promise<void> {
    if (state === "stopping" || state === "stopped") {
      return;
    }
    state = "stopping";
    if (deadline) {
      clearTimeout(deadline);
      deadline = undefined;
    }

    let error: unknown;
    try {
      await options.stop(mode);
    } catch (caught) {
      error = caught;
    }
    state = "stopped";
    resolveWait();
    options.onStopped?.(error);
  }

  function check(): void {
    if (state === "draining" && options.isSafe()) {
      void finish("safe");
    }
  }

  function request(): void {
    if (state !== "accepting") {
      return;
    }
    state = "draining";
    deadline = setTimeout(() => void finish("forced"), options.timeoutMs ?? DRAIN_TIMEOUT_MS);
    deadline.unref();
    check();
  }

  function force(): void {
    if (state === "accepting") {
      state = "draining";
    }
    if (state === "draining") {
      void finish("forced");
    }
  }

  return {
    get draining() {
      return state !== "accepting";
    },
    request,
    check,
    force,
    wait: () => stopped,
  };
}
