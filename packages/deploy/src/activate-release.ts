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
  await dependencies.stopService();
  await dependencies.switchRelease(options);
}
