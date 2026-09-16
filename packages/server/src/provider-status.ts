import type { ProviderStatus } from "@cinba/contract";
import type { CredentialSource } from "./effective-settings.ts";

/** Merge local auth metadata with the selected credential authority, without carrying secrets. */
export function effectiveProviderStatuses(
  localProviders: ProviderStatus[],
  credentialSource: CredentialSource,
  sharedProviderIds: ReadonlySet<string> = new Set(),
): ProviderStatus[] {
  return localProviders.map((provider) => {
    if (credentialSource === "local") {
      return { ...provider, management: "local" };
    }
    if (provider.source === "local-api-key") {
      return { ...provider, configured: false, source: "conflict", management: "sync" };
    }
    if (provider.source === "local-oauth") {
      return { ...provider, configured: true, management: "sync" };
    }
    if (sharedProviderIds.has(provider.id)) {
      return { ...provider, configured: true, source: "sync-api-key", management: "sync" };
    }
    return { id: provider.id, name: provider.name, configured: false, management: "sync" };
  });
}
