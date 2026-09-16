import { type SourceSelection, assertSupportedSources } from "./effective-settings.ts";

export type CredentialLookup = (providerId: string) => string | undefined;

export type RuntimeCredentialResolver = {
  /** Return only the requested provider value; never expose the backing collection. */
  get(providerId: string): string | undefined;
};

export function createRuntimeCredentialResolver(options: {
  sources: SourceSelection;
  local: CredentialLookup;
  shared?: CredentialLookup;
}): RuntimeCredentialResolver {
  assertSupportedSources(options.sources);
  if (options.sources.credentials === "sync" && !options.shared) {
    throw new Error("Shared Credentials are not available");
  }
  const lookup = options.sources.credentials === "local" ? options.local : options.shared!;
  return { get: (providerId) => lookup(providerId) };
}
