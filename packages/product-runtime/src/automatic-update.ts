import {
  type ProductPaths,
  type UpdateState,
  prepareProductUpdate,
  readUpdateState,
} from "@cinba/installer";
import type { ProductRelease } from "./release.ts";

export type ProductUpdateViewModel =
  | { phase: "idle" }
  | { phase: "current" }
  | { phase: "checking" }
  | { phase: "downloading" }
  | { phase: "ready"; candidateVersion: string }
  | { phase: "failed"; candidateVersion: string; message: string };

export type ProductUpdateReadinessReason =
  | "core-active-work"
  | "external-core"
  | "unverified-background-core"
  | "external-sync"
  | "unverified-background-sync"
  | "sync-active-requests";

export type ProductUpdateReadiness =
  | { status: "ready" }
  | {
      status: "waiting";
      reasonCode: ProductUpdateReadinessReason;
      message: string;
    };

const READINESS_REASONS = new Set<ProductUpdateReadinessReason>([
  "core-active-work",
  "external-core",
  "unverified-background-core",
  "external-sync",
  "unverified-background-sync",
  "sync-active-requests",
]);
const MAX_READINESS_MESSAGE_LENGTH = 2_048;

export function parseProductUpdateReadinessJson(value: string): ProductUpdateReadiness {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("update readiness JSON is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("update readiness JSON is invalid");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.status === "ready" && keys.length === 1 && keys[0] === "status") {
    return { status: "ready" };
  }
  if (
    record.status !== "waiting" ||
    keys.length !== 3 ||
    !keys.includes("status") ||
    !keys.includes("reasonCode") ||
    !keys.includes("message") ||
    typeof record.reasonCode !== "string" ||
    !READINESS_REASONS.has(record.reasonCode as ProductUpdateReadinessReason) ||
    typeof record.message !== "string" ||
    record.message.length < 1 ||
    record.message.length > MAX_READINESS_MESSAGE_LENGTH
  ) {
    throw new Error("update readiness JSON is invalid");
  }
  return {
    status: "waiting",
    reasonCode: record.reasonCode as ProductUpdateReadinessReason,
    message: record.message,
  };
}

export const CINBA_UPDATE_STATE_DIRECTORY_ENV = "CINBA_UPDATE_STATE_DIR";

type AutomaticUpdateDependencies = {
  prepare: typeof prepareProductUpdate;
  readState: typeof readUpdateState;
  delay: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

const AUTOMATIC_UPDATE_OBSERVE_INTERVAL_MS = 1_000;

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay) => {
    if (signal?.aborted) {
      resolveDelay();
      return;
    }
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolveDelay();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

const DEFAULT_DEPENDENCIES: AutomaticUpdateDependencies = {
  prepare: prepareProductUpdate,
  readState: readUpdateState,
  delay,
};

function isLeaseContention(error: unknown): boolean {
  return error instanceof Error && error.message === "another Cinba update operation is active";
}

function isTransient(state: UpdateState | undefined): boolean {
  return state?.phase === "checking" || state?.phase === "downloading";
}

async function waitToObserveAgain(
  dependencies: AutomaticUpdateDependencies,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) {
    return false;
  }
  let finishAbort!: () => void;
  const aborted = new Promise<void>((resolveAbort) => {
    finishAbort = () => resolveAbort();
    signal?.addEventListener("abort", finishAbort, { once: true });
  });
  await Promise.race([dependencies.delay(AUTOMATIC_UPDATE_OBSERVE_INTERVAL_MS, signal), aborted]);
  signal?.removeEventListener("abort", finishAbort);
  return !signal?.aborted;
}

export async function checkForProductUpdatesAutomatically(
  options: {
    release: ProductRelease;
    paths: Pick<ProductPaths, "stateDirectory" | "cacheDirectory">;
    signal?: AbortSignal;
    onUpdate?: (update: ProductUpdateViewModel) => void;
  },
  overrides: Partial<AutomaticUpdateDependencies> = {},
): Promise<UpdateState | undefined> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  let lastUpdate: ProductUpdateViewModel | undefined;
  const report = (state: UpdateState | undefined): void => {
    if (options.signal?.aborted) {
      return;
    }
    const update = toAutomaticUpdateViewModel(state);
    if (JSON.stringify(update) === JSON.stringify(lastUpdate)) {
      return;
    }
    lastUpdate = update;
    options.onUpdate?.(update);
  };
  while (!options.signal?.aborted) {
    try {
      const result = await dependencies.prepare({
        currentVersion: options.release.version,
        currentRevision: options.release.revision,
        target: options.release.target,
        stateDirectory: options.paths.stateDirectory,
        cacheDirectory: options.paths.cacheDirectory,
        automatic: true,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onUpdate ? { onStateChange: report } : {}),
      });
      report(result);
      return result;
    } catch (error) {
      if (options.signal?.aborted) {
        return undefined;
      }
      let shared: UpdateState | undefined;
      try {
        shared = await dependencies.readState(options.paths.stateDirectory);
      } catch {
        shared = undefined;
      }
      report(shared);
      if (!isLeaseContention(error) || !isTransient(shared)) {
        return shared;
      }
      if (!(await waitToObserveAgain(dependencies, options.signal))) {
        return undefined;
      }
    }
  }
  return undefined;
}

export function toAutomaticUpdateViewModel(state: UpdateState | undefined): ProductUpdateViewModel {
  if (state?.phase === "failed" && state.failure === "installation-failed" && state.candidate) {
    return {
      phase: "failed",
      candidateVersion: state.candidate.version,
      message: `Cinba ${state.candidate.version} could not be installed. Run cinba update to retry.`,
    };
  }
  if (!state || state.phase === "failed") {
    return { phase: "idle" };
  }
  if (state.phase === "ready") {
    return { phase: "ready", candidateVersion: state.candidate!.version };
  }
  return { phase: state.phase };
}
