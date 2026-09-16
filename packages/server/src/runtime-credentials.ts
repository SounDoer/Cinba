import { type SourceSelection, assertSupportedSources } from "./effective-settings.ts";

export type CredentialLookup = (providerId: string) => string | undefined;

export type RuntimeCredentialResolver = {
  /** Return only the requested provider value; never expose the backing collection. */
  get(providerId: string): string | undefined;
};

export class MissingSharedCredentialError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(`Shared credential is unavailable for provider ${providerId}`);
    this.name = "MissingSharedCredentialError";
    this.providerId = providerId;
  }
}

export function createRuntimeCredentialResolver(options: {
  sources: SourceSelection;
  local: CredentialLookup;
  shared?: CredentialLookup;
}): RuntimeCredentialResolver {
  assertSupportedSources(options.sources);
  if (options.sources.credentials === "local") {
    return { get: (providerId) => options.local(providerId) };
  }
  return {
    get: (providerId) => {
      const credential = options.shared?.(providerId);
      if (credential === undefined) {
        throw new MissingSharedCredentialError(providerId);
      }
      return credential;
    },
  };
}
