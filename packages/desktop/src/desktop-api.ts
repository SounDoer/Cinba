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
): { hidden: boolean; label: string } {
  if (
    productName === "Cinba Dev" ||
    !update ||
    update.phase === "idle" ||
    update.phase === "current"
  ) {
    return { hidden: true, label: "" };
  }
  if (update.phase === "ready") {
    return { hidden: false, label: `Update ${update.candidateVersion} Ready` };
  }
  return {
    hidden: false,
    label: update.phase === "checking" ? "Checking for Updates" : "Downloading Update",
  };
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
