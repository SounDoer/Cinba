import { test } from "node:test";
import assert from "node:assert/strict";
import { temporaryDirectory } from "@cinba/test-support";

// Point Pi's entire agent directory at a throwaway one before importing the
// module under test, so these tests can log in and out without going anywhere
// near the real ~/.pi/agent/auth.json.
const agentDir = temporaryDirectory("cinba-credentials-test-").replace(/\\/g, "/");
process.env.PI_CODING_AGENT_DIR = agentDir;

const { clearCredential, listCoreCapabilities, listProviders, setApiKey } =
  await import("./credentials.ts");

const FAKE_KEY = "sk-this-is-not-a-real-key-0123456789";

test("a stored key makes its provider configured, and is never handed back", async () => {
  const before = await listProviders();
  assert.ok(before.length > 10, "Pi knows about many providers");
  assert.equal(
    before.find((provider) => provider.id === "groq")?.configured,
    false,
    "nothing is configured in a fresh directory",
  );

  await setApiKey("groq", FAKE_KEY);

  const after = await listProviders();
  assert.equal(after.find((provider) => provider.id === "groq")?.configured, true);

  // The whole point of this module: a key goes in and does not come back out.
  // Serialising the entire reply is the bluntest possible way to check, which
  // is what makes it a good check.
  assert.equal(
    JSON.stringify(after).includes(FAKE_KEY),
    false,
    "the listing must not carry the secret it is reporting on",
  );

  await clearCredential("groq");
  const cleared = await listProviders();
  assert.equal(cleared.find((provider) => provider.id === "groq")?.configured, false);
});

test("configured providers sort to the top, where they are worth looking at", async () => {
  await setApiKey("groq", FAKE_KEY);
  const providers = await listProviders();
  assert.equal(providers[0]?.id, "groq");
  await clearCredential("groq");
});

test("runtime API keys expose model capabilities without persisting or returning the key", async () => {
  const capabilities = await listCoreCapabilities({ deepseek: FAKE_KEY });

  assert.ok(capabilities.models.some((model) => model.provider === "deepseek"));
  assert.ok(capabilities.providers.some((provider) => provider.id === "deepseek"));
  assert.equal(JSON.stringify(capabilities).includes(FAKE_KEY), false);
  assert.equal(
    (await listProviders()).find((provider) => provider.id === "deepseek")?.configured,
    false,
  );
});

test("Shared Credentials capabilities exclude conflicting local API-key models", async () => {
  await setApiKey("groq", FAKE_KEY);
  const capabilities = await listCoreCapabilities({ deepseek: "shared-not-a-real-key" });

  assert.ok(capabilities.models.some((model) => model.provider === "deepseek"));
  assert.equal(
    capabilities.models.some((model) => model.provider === "groq"),
    false,
  );
  await clearCredential("groq");
});

test("a secret is stripped from any text on its way out", async () => {
  const { redactSecret } = await import("./credentials.ts");

  // Measured, not imagined: asking Amazon Bedrock to log in with an api_key
  // answered the wrong question and came back quoting the key.
  assert.equal(
    redactSecret(`Unknown Amazon Bedrock auth method: ${FAKE_KEY}`, FAKE_KEY),
    "Unknown Amazon Bedrock auth method: [redacted]",
  );
  assert.equal(redactSecret(`${FAKE_KEY} and ${FAKE_KEY}`, FAKE_KEY), "[redacted] and [redacted]");
  assert.equal(redactSecret("nothing to hide", FAKE_KEY), "nothing to hide");
  assert.equal(
    redactSecret("an empty secret matches nothing", ""),
    "an empty secret matches nothing",
  );
});

test("a provider needing a sign-in this cannot do says so, without quoting the key", async () => {
  await assert.rejects(
    () => setApiKey("amazon-bedrock", FAKE_KEY),
    (error: Error) => {
      assert.equal(error.message.includes(FAKE_KEY), false, "the key must not be in the message");
      assert.match(error.message, /pi/, "and it should point at the tool that can do it");
      return true;
    },
  );
});
