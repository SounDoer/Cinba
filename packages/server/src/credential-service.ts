// Coordinates credential changes for the server without knowing who requested them.

import {
  clearCredential as clearStoredCredential,
  listProviders as listStoredProviders,
  setApiKey as storeApiKey,
} from "@cinba/agent";
import type { ProviderStatus } from "@cinba/contract";

export type CredentialResult = {
  success: boolean;
  notice: string;
};

export type CredentialService = {
  list(): Promise<ProviderStatus[]>;
  configure(providerId: string, apiKey: string): Promise<CredentialResult>;
  remove(providerId: string): Promise<CredentialResult>;
};

export type CredentialServiceOptions = {
  onChanged: () => void;
  canConfigure?: () => boolean;
  listProviders?: () => Promise<ProviderStatus[]>;
  setApiKey?: (providerId: string, apiKey: string) => Promise<void>;
  clearCredential?: (providerId: string) => Promise<void>;
};

export function createCredentialService(options: CredentialServiceOptions): CredentialService {
  const listProviders = options.listProviders ?? listStoredProviders;
  const setApiKey = options.setApiKey ?? storeApiKey;
  const clearCredential = options.clearCredential ?? clearStoredCredential;

  return {
    list: listProviders,

    async configure(providerId, apiKey) {
      if (options.canConfigure?.() === false) {
        return { success: false, notice: "API keys are managed by Cinba Sync" };
      }
      try {
        await setApiKey(providerId, apiKey);
        options.onChanged();
        return { success: true, notice: `${providerId} is configured` };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { success: false, notice: `could not configure: ${reason}` };
      }
    },

    async remove(providerId) {
      await clearCredential(providerId);
      options.onChanged();
      return { success: true, notice: `${providerId} is no longer configured` };
    },
  };
}
