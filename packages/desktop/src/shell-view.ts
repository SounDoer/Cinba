import type { CoreNavigatorState } from "./core-navigator.ts";
import type { CoreProfile } from "./profiles.ts";

export type ShellViewModel = {
  profiles: CoreProfile[];
  selectedProfileId: string;
  status: CoreNavigatorState["type"];
  message?: string;
  canRetry: boolean;
  canManage: boolean;
};

export function createShellViewModel(
  profiles: CoreProfile[],
  connection: CoreNavigatorState,
): ShellViewModel {
  return {
    profiles,
    selectedProfileId: connection.profile.id,
    status: connection.type,
    ...(connection.type === "offline" ? { message: connection.message } : {}),
    canRetry: connection.type === "offline",
    canManage: true,
  };
}
