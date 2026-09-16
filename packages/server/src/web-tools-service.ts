import type {
  WebSearchCredentialProviderId,
  WebSearchCredentialSource,
  WebSearchPrimary,
  WebSearchProviderId,
  WebSearchProviderStatus,
  WebToolsConfigurationSource,
  WebToolsStatus,
} from "@cinba/contract";

export type WebToolsCredentialStatus = {
  configured: boolean;
  source?: WebSearchCredentialSource;
  hasStoredCredential: boolean;
};

export type WebToolsCredentialStore = {
  getCredentialStatus(provider: WebSearchCredentialProviderId): WebToolsCredentialStatus;
  setApiKey(provider: WebSearchCredentialProviderId, apiKey: string): void;
  clearApiKey(provider: WebSearchCredentialProviderId): void;
};

export type WebToolsServiceOptions = {
  getPrimary(): WebSearchPrimary;
  setPrimary(primary: WebSearchPrimary): void;
  getSources?(): {
    settings: WebToolsConfigurationSource;
    credentials: WebToolsConfigurationSource;
  };
  credentials: WebToolsCredentialStore;
};

export type WebToolsService = {
  getStatus(): WebToolsStatus;
  configure(provider: WebSearchCredentialProviderId, apiKey: string): WebToolsStatus;
  remove(provider: WebSearchCredentialProviderId): WebToolsStatus;
  choosePrimary(primary: WebSearchPrimary): WebToolsStatus;
};

function providerStatus(
  id: WebSearchCredentialProviderId,
  name: string,
  credential: WebToolsCredentialStatus,
): WebSearchProviderStatus {
  return {
    id,
    name,
    available: credential.configured,
    ...(credential.source ? { source: credential.source } : {}),
    hasStoredCredential: credential.hasStoredCredential,
    bestEffort: false,
  };
}

export function createWebToolsService(options: WebToolsServiceOptions): WebToolsService {
  function getStatus(): WebToolsStatus {
    const primary = options.getPrimary();
    const sources = options.getSources?.() ?? { settings: "local", credentials: "local" };
    const exa = providerStatus("exa", "Exa", options.credentials.getCredentialStatus("exa"));
    const brave = providerStatus(
      "brave",
      "Brave Search",
      options.credentials.getCredentialStatus("brave"),
    );
    const providers: WebSearchProviderStatus[] = [
      exa,
      brave,
      {
        id: "duckduckgo",
        name: "DuckDuckGo",
        available: true,
        hasStoredCredential: false,
        bestEffort: true,
      },
    ];
    const configured = new Set(
      providers.filter((provider) => provider.available).map((provider) => provider.id),
    );
    const preferred: WebSearchProviderId[] =
      primary === "brave" ? ["brave", "exa", "duckduckgo"] : ["exa", "brave", "duckduckgo"];

    return {
      primary,
      effectiveOrder: preferred.filter((provider) => configured.has(provider)),
      providers,
      settingsSource: sources.settings,
      credentialSource: sources.credentials,
    };
  }

  return {
    getStatus,
    configure(provider, apiKey) {
      if (options.getSources?.().credentials === "sync") {
        throw new Error("Web search credentials are managed by Sync");
      }
      options.credentials.setApiKey(provider, apiKey);
      return getStatus();
    },
    remove(provider) {
      if (options.getSources?.().credentials === "sync") {
        throw new Error("Web search credentials are managed by Sync");
      }
      options.credentials.clearApiKey(provider);
      return getStatus();
    },
    choosePrimary(primary) {
      if (options.getSources?.().settings === "sync") {
        throw new Error("Web search settings are managed by Sync");
      }
      options.setPrimary(primary);
      return getStatus();
    },
  };
}
