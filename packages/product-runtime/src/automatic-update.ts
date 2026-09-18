import {
  type ProductPaths,
  type UpdateState,
  prepareProductUpdate,
  readUpdateState,
} from "@cinba/installer";
import type { ProductRelease } from "./release.ts";

export type AutomaticUpdateViewModel =
  | { phase: "idle" }
  | { phase: "current" }
  | { phase: "checking" }
  | { phase: "downloading" }
  | { phase: "ready"; candidateVersion: string };

type AutomaticUpdateDependencies = {
  prepare: typeof prepareProductUpdate;
  readState: typeof readUpdateState;
};

const DEFAULT_DEPENDENCIES: AutomaticUpdateDependencies = {
  prepare: prepareProductUpdate,
  readState: readUpdateState,
};

export async function checkForProductUpdatesAutomatically(
  options: {
    release: ProductRelease;
    paths: Pick<ProductPaths, "stateDirectory" | "cacheDirectory">;
    signal?: AbortSignal;
  },
  overrides: Partial<AutomaticUpdateDependencies> = {},
): Promise<UpdateState | undefined> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  try {
    return await dependencies.prepare({
      currentVersion: options.release.version,
      currentRevision: options.release.revision,
      target: options.release.target,
      stateDirectory: options.paths.stateDirectory,
      cacheDirectory: options.paths.cacheDirectory,
      automatic: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    try {
      return await dependencies.readState(options.paths.stateDirectory);
    } catch {
      return undefined;
    }
  }
}

export function toAutomaticUpdateViewModel(
  state: UpdateState | undefined,
): AutomaticUpdateViewModel {
  if (!state || state.phase === "failed") {
    return { phase: "idle" };
  }
  if (state.phase === "ready") {
    return { phase: "ready", candidateVersion: state.candidate!.version };
  }
  return { phase: state.phase };
}
