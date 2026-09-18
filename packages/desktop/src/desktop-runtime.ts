import { dirname, resolve } from "node:path";

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
}): DesktopRuntime {
  if (options.packaged) {
    return {
      identity: "release",
      displayName: "Cinba",
      applicationId: "com.soundoer.cinba",
      payloadRoot: resolve(options.resourcesPath, "payload"),
    };
  }
  return {
    identity: "development",
    displayName: "Cinba Dev",
    applicationId: "com.soundoer.cinba.dev",
    repositoryRoot: resolve(dirname(options.modulePath), "..", "..", ".."),
  };
}
