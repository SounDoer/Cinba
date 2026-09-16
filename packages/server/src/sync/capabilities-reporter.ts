import type { CapabilitiesReport, CoreCapabilities } from "@cinba/sync-contract";

export type CapabilitiesRemote = {
  report(report: CapabilitiesReport, signal?: AbortSignal): Promise<unknown>;
};

export type CapabilitiesReporter = {
  reportIfChanged(signal?: AbortSignal): Promise<boolean>;
  reset(): void;
};

export function createCapabilitiesReporter(options: {
  remote(): CapabilitiesRemote | undefined;
  capabilities(): CoreCapabilities | Promise<CoreCapabilities>;
  appVersion: string;
  syncState(): { currentSyncRevision?: number; lastSyncErrorCode?: string };
}): CapabilitiesReporter {
  let lastAccepted: string | undefined;
  return {
    reportIfChanged: async (signal) => {
      const remote = options.remote();
      if (!remote) {
        return false;
      }
      const state = options.syncState();
      const report: CapabilitiesReport = {
        version: 1,
        appVersion: options.appVersion,
        capabilities: await options.capabilities(),
        ...(state.currentSyncRevision === undefined
          ? {}
          : { currentSyncRevision: state.currentSyncRevision }),
        ...(state.lastSyncErrorCode === undefined
          ? {}
          : { lastSyncErrorCode: state.lastSyncErrorCode }),
      };
      const serialized = JSON.stringify(report);
      if (serialized === lastAccepted) {
        return false;
      }
      await remote.report(report, signal);
      lastAccepted = serialized;
      return true;
    },
    reset: () => {
      lastAccepted = undefined;
    },
  };
}
