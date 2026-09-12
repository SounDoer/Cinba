import { stopCoreService } from "./core-service.ts";
import { switchCurrentRelease } from "./switch-release.ts";

type ActivationOptions = {
  releasesRoot: string;
  currentLink: string;
  targetRevision: string;
  expectedCurrentRevision?: string;
};

type ActivationDependencies = {
  stopService: () => Promise<void>;
  switchRelease: (options: ActivationOptions) => Promise<void>;
};

export class ReleaseActivationError extends Error {
  readonly failure: "drain" | "switch";

  constructor(failure: "drain" | "switch", cause: unknown) {
    super(`Release activation failed during ${failure}`, { cause });
    this.name = "ReleaseActivationError";
    this.failure = failure;
  }
}

const DEFAULT_DEPENDENCIES: ActivationDependencies = {
  stopService: stopCoreService,
  switchRelease: switchCurrentRelease,
};

/** Drain and stop the old core before atomically activating a prepared release. */
export async function activatePreparedRelease(
  options: ActivationOptions,
  overrides: Partial<ActivationDependencies> = {},
): Promise<void> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  try {
    await dependencies.stopService();
  } catch (error) {
    throw new ReleaseActivationError("drain", error);
  }
  try {
    await dependencies.switchRelease(options);
  } catch (error) {
    throw new ReleaseActivationError("switch", error);
  }
}
