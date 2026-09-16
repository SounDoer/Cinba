import type { ShellViewModel } from "./shell-view.ts";
import type { SyncProfile } from "./sync-profile.ts";

export type DesktopShellState = ShellViewModel & {
  problem?: string;
  canRecoverProfiles: boolean;
  selectedKind: "core" | "sync";
  syncProfile?: SyncProfile;
};

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
  openSync(): Promise<void>;
  saveSync(baseUrl: string): Promise<void>;
  removeSync(): Promise<void>;
  openSyncExternal(): Promise<void>;
  retry(): Promise<void>;
  openManager(): Promise<void>;
  addProfile(input: ProfileInput): Promise<void>;
  updateProfile(profileId: string, input: ProfileInput): Promise<void>;
  removeProfile(profileId: string): Promise<void>;
  recoverProfiles(): Promise<string>;
  testProfile(input: ProfileInput): Promise<ConnectionTestResult>;
  onStateChanged(listener: (state: DesktopShellState) => void): () => void;
};
