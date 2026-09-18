import { dirname, isAbsolute, resolve } from "node:path";

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
