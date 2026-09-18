import { dirname, isAbsolute, resolve } from "node:path";
import {
  type ProductRelease,
  type ProductUpdateViewModel,
  checkForProductUpdatesAutomatically,
} from "@cinba/product-runtime";

export type DesktopRuntime =
  | {
      identity: "development";
      displayName: "Cinba Dev";
      applicationId: "com.soundoer.cinba.dev";
      repositoryRoot: string;
    }
  | {
      identity: "release";
      displayName: "Cinba";
      applicationId: "com.soundoer.cinba";
      payloadRoot: string;
    };

type DesktopAutomaticUpdateOptions =
  | { runtime: { identity: "development" } }
  | {
      runtime: { identity: "release" };
      release: ProductRelease;
      paths: { stateDirectory: string; cacheDirectory: string };
      onUpdate: (update: ProductUpdateViewModel) => void;
    };

type AutomaticUpdateCheck = typeof checkForProductUpdatesAutomatically;

export function startDesktopAutomaticUpdate(
  options: DesktopAutomaticUpdateOptions,
  check: AutomaticUpdateCheck = checkForProductUpdatesAutomatically,
): { abort(): void } | undefined {
  if (!("release" in options)) {
    return undefined;
  }
  const controller = new AbortController();
  void check({
    release: options.release,
    paths: options.paths,
    signal: controller.signal,
    onUpdate: options.onUpdate,
  }).catch(() => undefined);
  return { abort: () => controller.abort() };
}

export function resolveDesktopRuntime(options: {
  packaged: boolean;
  modulePath: string;
  resourcesPath: string;
  installedPayloadRoot?: string;
}): DesktopRuntime {
  if (options.packaged) {
    if (!options.installedPayloadRoot || !isAbsolute(options.installedPayloadRoot)) {
      throw new Error("packaged Desktop requires an absolute installed payload root");
    }
    return {
      identity: "release",
      displayName: "Cinba",
      applicationId: "com.soundoer.cinba",
      payloadRoot: resolve(options.installedPayloadRoot),
    };
  }
  return {
    identity: "development",
    displayName: "Cinba Dev",
    applicationId: "com.soundoer.cinba.dev",
    repositoryRoot: resolve(dirname(options.modulePath), "..", "..", ".."),
  };
}
