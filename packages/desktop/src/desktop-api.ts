import type { ProductUpdateViewModel } from "@cinba/product-runtime";
import type { ShellViewModel } from "./shell-view.ts";

export type DesktopShellState = ShellViewModel & {
  productName: "Cinba" | "Cinba Dev";
  problem?: string;
  canRecoverProfiles: boolean;
  update?: ProductUpdateViewModel;
};

export function createDesktopUpdateState(broadcast: () => void): {
  get(): ProductUpdateViewModel | undefined;
  set(update: ProductUpdateViewModel): void;
} {
  let current: ProductUpdateViewModel | undefined;
  return {
    get: () => current,
    set: (update) => {
      current = update;
      broadcast();
    },
  };
}

export function createDesktopUpdatePresentation(
  productName: "Cinba" | "Cinba Dev",
  update: ProductUpdateViewModel | undefined,
): { hidden: boolean; label: string; actionable: boolean; ariaLabel: string } {
  if (
    productName === "Cinba Dev" ||
    !update ||
    update.phase === "idle" ||
    update.phase === "current"
  ) {
    return { hidden: true, label: "", actionable: false, ariaLabel: "" };
  }
  if (update.phase === "ready") {
    return {
      hidden: false,
      label: `Update ${update.candidateVersion} Ready`,
      actionable: true,
      ariaLabel: `Install Cinba ${update.candidateVersion} and restart`,
    };
  }
  if (update.phase === "failed") {
    return {
      hidden: false,
      label: `Update ${update.candidateVersion} Failed`,
      actionable: false,
      ariaLabel: `Cinba ${update.candidateVersion} update installation failed`,
    };
  }
  if (update.phase === "blocked") {
    const incompatible = update.reason === "incompatible";
    return {
      hidden: false,
      label: incompatible
        ? `Update ${update.candidateVersion} Requires a Newer System`
        : `Update ${update.candidateVersion} Compatibility Unknown`,
      actionable: false,
      ariaLabel: incompatible
        ? `Cinba ${update.candidateVersion} requires a newer system`
        : `Cinba ${update.candidateVersion} system compatibility is unknown`,
    };
  }
  return {
    hidden: false,
    label: update.phase === "checking" ? "Checking for Updates" : "Downloading Update",
    actionable: false,
    ariaLabel:
      update.phase === "checking" ? "Checking for Cinba updates" : "Downloading a Cinba update",
  };
}

export async function activateDesktopUpdate(
  presentation: ReturnType<typeof createDesktopUpdatePresentation>,
  install: () => Promise<void>,
): Promise<void> {
  if (presentation.actionable) {
    await install();
  }
}

export type ProfileInput = {
  label: string;
  baseUrl: string;
};

export type ConnectionTestResult =
  | { reachable: true; revision: string; safeToRestart: boolean }
  | { reachable: false; message: string };

export type CinbaDesktopApi = {
  getState(): Promise<DesktopShellState>;
  installReadyUpdate(): Promise<void>;
  selectProfile(profileId: string): Promise<void>;
  retry(): Promise<void>;
  openManager(): Promise<void>;
  addProfile(input: ProfileInput): Promise<void>;
  updateProfile(profileId: string, input: ProfileInput): Promise<void>;
  removeProfile(profileId: string): Promise<void>;
  recoverProfiles(): Promise<string>;
  testProfile(input: ProfileInput): Promise<ConnectionTestResult>;
  onStateChanged(listener: (state: DesktopShellState) => void): () => void;
};
