import {
  type LocalProviderAuthType,
  localProviderEnvironmentCredential,
  providerEnvironmentVariable,
} from "@cinba/agent";
import type { CredentialSource } from "../effective-settings.ts";

export class ProviderCredentialConflictError extends Error {
  constructor(providerId: string) {
    super(
      `Provider ${providerId} has a local API-key entry that conflicts with Shared Credentials`,
    );
    this.name = "ProviderCredentialConflictError";
  }
}

export class ProviderLoginRequiredError extends Error {
  constructor(providerId: string) {
    super(`Provider ${providerId} requires a local login or a Shared API key`);
    this.name = "ProviderLoginRequiredError";
  }
}

export class ProviderCredentialUnsupportedError extends Error {
  constructor(providerId: string) {
    super(`Provider ${providerId} does not support Shared API-key injection`);
    this.name = "ProviderCredentialUnsupportedError";
  }
}

export function resolveProviderCredential(options: {
  providerId: string;
  source: CredentialSource;
  sharedCredential?: string;
  localAuthType?: LocalProviderAuthType;
  environment?: Record<string, string | undefined>;
}): string | undefined {
  if (options.source === "local") {
    return localProviderEnvironmentCredential(options.providerId, options.environment);
  }
  if (options.localAuthType === "api_key") {
    throw new ProviderCredentialConflictError(options.providerId);
  }
  if (options.localAuthType === "oauth") {
    return undefined;
  }
  if (options.sharedCredential === undefined) {
    throw new ProviderLoginRequiredError(options.providerId);
  }
  if (!providerEnvironmentVariable(options.providerId)) {
    throw new ProviderCredentialUnsupportedError(options.providerId);
  }
  return options.sharedCredential;
}
