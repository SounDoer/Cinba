import { writeAtomicJson } from "../atomic-json-store.ts";
import type { CredentialSource, Settings } from "../effective-settings.ts";

export type WebToolsRuntimeConfiguration = {
  version: 1;
  webTools: {
    searchPrimary: Settings["webTools"]["searchPrimary"];
    apiKeys: { exa?: string; brave?: string };
  };
};

function parse(value: unknown): WebToolsRuntimeConfiguration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected Web tools runtime configuration");
  }
  const document = value as Record<string, unknown>;
  const webTools = document.webTools as Record<string, unknown> | undefined;
  const apiKeys = webTools?.apiKeys as Record<string, unknown> | undefined;
  if (
    document.version !== 1 ||
    !webTools ||
    !apiKeys ||
    !["auto", "exa", "brave"].includes(String(webTools.searchPrimary)) ||
    (apiKeys.exa !== undefined && typeof apiKeys.exa !== "string") ||
    (apiKeys.brave !== undefined && typeof apiKeys.brave !== "string")
  ) {
    throw new Error("invalid Web tools runtime configuration");
  }
  return value as WebToolsRuntimeConfiguration;
}

export function writeWebToolsRuntimeConfiguration(
  path: string,
  configuration: WebToolsRuntimeConfiguration,
): void {
  writeAtomicJson(path, configuration, parse);
}

export function resolveWebToolsRuntimeConfiguration(options: {
  settings: Settings;
  credentialSource: CredentialSource;
  localCredential(provider: "exa" | "brave"): string | undefined;
  sharedCredentials?: Record<string, string>;
}): WebToolsRuntimeConfiguration {
  const credential = (provider: "exa" | "brave") =>
    options.credentialSource === "local"
      ? options.localCredential(provider)
      : options.sharedCredentials?.[provider];
  const exa = credential("exa");
  const brave = credential("brave");
  return {
    version: 1,
    webTools: {
      searchPrimary: options.settings.webTools.searchPrimary,
      apiKeys: { ...(exa ? { exa } : {}), ...(brave ? { brave } : {}) },
    },
  };
}
