import { isAbsolute } from "node:path";
import { readUpdateState } from "@cinba/installer";
import {
  CINBA_UPDATE_STATE_DIRECTORY_ENV,
  type ProductUpdateViewModel,
  toAutomaticUpdateViewModel,
} from "@cinba/product-runtime/automatic-update";

type IntervalHandle = {
  unref(): void;
};

type UpdateObserverDependencies = {
  readState: typeof readUpdateState;
  setInterval: (callback: () => void, milliseconds: number) => IntervalHandle;
  clearInterval: (timer: IntervalHandle) => void;
};

const DEFAULT_DEPENDENCIES: UpdateObserverDependencies = {
  readState: readUpdateState,
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
};

const UPDATE_OBSERVE_INTERVAL_MS = 1_000;

export function startProductUpdateObserver(
  options: {
    environment: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    onUpdate: (update: ProductUpdateViewModel) => void;
  },
  overrides: Partial<UpdateObserverDependencies> = {},
): { dispose(): void } | undefined {
  const stateDirectory = options.environment[CINBA_UPDATE_STATE_DIRECTORY_ENV];
  if (!stateDirectory || !isAbsolute(stateDirectory) || options.signal?.aborted) {
    return undefined;
  }
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  let disposed = false;
  let reading = false;
  let lastUpdate: ProductUpdateViewModel | undefined;

  const poll = async (): Promise<void> => {
    if (disposed || reading) {
      return;
    }
    reading = true;
    let state;
    try {
      state = await dependencies.readState(stateDirectory);
    } catch {
      state = undefined;
    } finally {
      reading = false;
    }
    if (disposed) {
      return;
    }
    const update = toAutomaticUpdateViewModel(state);
    if (JSON.stringify(update) === JSON.stringify(lastUpdate)) {
      return;
    }
    lastUpdate = update;
    options.onUpdate(update);
  };

  const timer = dependencies.setInterval(() => void poll(), UPDATE_OBSERVE_INTERVAL_MS);
  timer.unref();
  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    dependencies.clearInterval(timer);
    options.signal?.removeEventListener("abort", dispose);
  };
  options.signal?.addEventListener("abort", dispose, { once: true });
  void poll();
  return { dispose };
}

function readyNotice(version: string): string {
  return `Cinba ${version} is ready. Type /update to install.`;
}

export function createDeferredReadyNotice(): {
  receive(version: string, canShow: boolean): string | undefined;
  flush(canShow: boolean): string | undefined;
  reset(): void;
} {
  const seenVersions = new Set<string>();
  let pendingVersion: string | undefined;
  return {
    receive: (version, canShow) => {
      if (seenVersions.has(version) || pendingVersion === version) {
        return undefined;
      }
      if (canShow) {
        seenVersions.add(version);
        return readyNotice(version);
      }
      pendingVersion = version;
      return undefined;
    },
    flush: (canShow) => {
      if (!canShow || !pendingVersion) {
        return undefined;
      }
      const version = pendingVersion;
      pendingVersion = undefined;
      seenVersions.add(version);
      return readyNotice(version);
    },
    reset: () => {
      pendingVersion = undefined;
    },
  };
}

function createDeferredFailureNotice(): {
  receive(version: string, message: string, canShow: boolean): string | undefined;
  flush(canShow: boolean): string | undefined;
  reset(): void;
} {
  let activeVersion: string | undefined;
  let pending: { version: string; message: string } | undefined;
  return {
    receive: (version, message, canShow) => {
      if (activeVersion === version) {
        return undefined;
      }
      activeVersion = version;
      if (canShow) {
        return message;
      }
      pending = { version, message };
      return undefined;
    },
    flush: (canShow) => {
      if (!canShow || !pending) {
        return undefined;
      }
      const message = pending.message;
      pending = undefined;
      return message;
    },
    reset: () => {
      activeVersion = undefined;
      pending = undefined;
    },
  };
}

export type TuiUpdateConsumer = ((update: ProductUpdateViewModel) => void) & {
  flushNotice(): void;
};

export function createTuiUpdateConsumer(options: {
  setStatus: (update: ProductUpdateViewModel) => void;
  appendNotice: (notice: string) => void;
  requestRender: () => void;
  canAppendNotice?: () => boolean;
}): TuiUpdateConsumer {
  const notices = createDeferredReadyNotice();
  const failures = createDeferredFailureNotice();
  const blockers = createDeferredFailureNotice();
  const canAppendNotice = options.canAppendNotice ?? (() => true);
  const append = (notice: string | undefined): void => {
    if (notice) {
      options.appendNotice(notice);
    }
  };
  const consume = ((update: ProductUpdateViewModel) => {
    options.setStatus(update);
    if (update.phase === "ready") {
      failures.reset();
      blockers.reset();
      append(notices.receive(update.candidateVersion, canAppendNotice()));
    } else if (update.phase === "failed") {
      notices.reset();
      blockers.reset();
      append(failures.receive(update.candidateVersion, update.message, canAppendNotice()));
    } else if (update.phase === "blocked") {
      notices.reset();
      failures.reset();
      append(
        blockers.receive(
          `${update.reason}:${update.candidateVersion}`,
          update.message,
          canAppendNotice(),
        ),
      );
    } else {
      notices.reset();
      failures.reset();
      blockers.reset();
    }
    options.requestRender();
  }) as TuiUpdateConsumer;
  consume.flushNotice = () => {
    const canShow = canAppendNotice();
    const pending = [
      notices.flush(canShow),
      failures.flush(canShow),
      blockers.flush(canShow),
    ].filter((notice): notice is string => notice !== undefined);
    if (pending.length > 0) {
      for (const notice of pending) {
        options.appendNotice(notice);
      }
      options.requestRender();
    }
  };
  return consume;
}
