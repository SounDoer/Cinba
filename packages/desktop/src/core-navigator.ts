import type { CoreProfile } from "./profiles.ts";

export type CoreNavigatorState =
  | { type: "opening"; profile: CoreProfile }
  | { type: "online"; profile: CoreProfile }
  | { type: "offline"; profile: CoreProfile; message: string };

export type CoreNavigator = {
  open(profile: CoreProfile): Promise<CoreNavigatorState>;
  current(): CoreNavigatorState | undefined;
};

export function createCoreNavigator(options: {
  ensureLocal(): Promise<void>;
  probe(baseUrl: string): Promise<boolean>;
  load(baseUrl: string): Promise<void>;
}): CoreNavigator {
  let requestId = 0;
  let state: CoreNavigatorState | undefined;
  return {
    open: async (profile) => {
      requestId += 1;
      const currentRequest = requestId;
      state = { type: "opening", profile };
      try {
        if (profile.kind === "local") {
          await options.ensureLocal();
        }
        if (!(await options.probe(profile.baseUrl))) {
          const result: CoreNavigatorState = {
            type: "offline",
            profile,
            message: `${profile.label} is unavailable`,
          };
          if (currentRequest === requestId) {
            state = result;
          }
          return result;
        }
        if (currentRequest !== requestId) {
          return { type: "online", profile };
        }
        await options.load(profile.baseUrl);
        const result: CoreNavigatorState = { type: "online", profile };
        if (currentRequest === requestId) {
          state = result;
        }
        return result;
      } catch (error) {
        const result: CoreNavigatorState = {
          type: "offline",
          profile,
          message: error instanceof Error ? error.message : String(error),
        };
        if (currentRequest === requestId) {
          state = result;
        }
        return result;
      }
    },
    current: () => state,
  };
}
