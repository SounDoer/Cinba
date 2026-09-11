// Which providers this machine can talk to, and how that gets configured.
//
// The one place in this project that handles an API key. Everywhere else the
// core passes Pi the *names* of a provider and a model and Pi reads its own
// credential file, so a key never enters our process at all. Here it does, for
// one reason: adding a provider is the second half of "model and vendor
// freedom", and having to quit and run `pi` to do it undercuts the first half.
//
// The rule that keeps that affordable: **a key goes in and never comes back
// out**. Nothing here returns one, and nothing that calls it may put one in a
// log, a ledger or a snapshot.
//
// This reaches into Pi's exported API rather than its RPC protocol, because
// Pi's RPC has no login command among its thirty-three. That makes it tier ②
// in the interface inventory: exported code with no protocol promise, so it is
// a decision to weigh rather than a wiring job.

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderStatus } from "@cinba/contract";

// The wire type, not a copy of it: what this function reports is exactly what
// travels, and a second definition would be free to drift into carrying a key.

/**
 * Every provider Pi knows about, and whether this machine has credentials for
 * it. Deliberately shaped so it cannot carry a secret.
 */
export async function listProviders(): Promise<ProviderStatus[]> {
  const runtime = await ModelRuntime.create();

  return runtime
    .getProviders()
    .map((provider) => {
      const { id, name } = provider as { id: string; name?: string };
      return {
        id,
        name: name || id,
        configured: runtime.hasConfiguredAuth(id),
      };
    })
    .toSorted((a, b) => {
      // Configured first: with forty providers, the few that work are what you
      // came to look at.
      const byConfigured = Number(b.configured) - Number(a.configured);
      return byConfigured !== 0 ? byConfigured : a.id.localeCompare(b.id);
    });
}

/**
 * Store an API key for a provider.
 *
 * Through Pi's login rather than by writing auth.json ourselves, so the file
 * stays entirely Pi's business and `pi` on the command line sees the same
 * credentials. login is callback-driven — it asks for whatever the method
 * needs — and for api_key it asks exactly once, for the key.
 *
 * Note it is login(), not setRuntimeApiKey(): despite the name, the latter is
 * an in-memory overlay that vanishes with the process.
 */
export async function setApiKey(providerId: string, apiKey: string): Promise<void> {
  const runtime = await ModelRuntime.create();

  try {
    await runtime.login(providerId, "api_key", {
      prompt: (request: { type?: string; message?: string }) => {
        // Answer only the question this function exists to answer. Some
        // providers ask something else first -- Amazon Bedrock asks which auth
        // method to use -- and replying with the key would both mean nothing
        // and hand the key to a question that was not about it. Measured:
        // doing so came back as "Unknown Amazon Bedrock auth method:
        // <the key>", which is how a secret ends up on screen.
        if (request?.type !== "secret") {
          throw new Error(
            `${providerId} needs a sign-in this cannot do. Use "pi" and its /login command.`,
          );
        }
        return apiKey;
      },
      notify: () => {},
    } as never);
  } catch (error) {
    // The provider's original error may contain the key. Attaching it as `cause`
    // would bypass the redacted public message and keep the secret reachable.
    // oxlint-disable-next-line preserve-caught-error
    throw new Error(redactSecret(errorText(error), apiKey));
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Remove a secret from text that is about to travel.
 *
 * A backstop, not the main defence: the prompt check above should keep a key
 * out of provider errors in the first place. But those messages are written by
 * forty providers we do not control, and one of them echoing back what it was
 * given must not be the thing that decides whether a key reaches a screen.
 */
export function redactSecret(text: string, secret: string): string {
  if (secret === "" || !text.includes(secret)) {
    return text;
  }
  return text.split(secret).join("[redacted]");
}

/** Forget a provider's credential. */
export async function clearCredential(providerId: string): Promise<void> {
  const runtime = await ModelRuntime.create();
  await runtime.logout(providerId);
}
