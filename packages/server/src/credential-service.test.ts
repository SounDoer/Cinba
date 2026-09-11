import { test } from "node:test";
import assert from "node:assert/strict";
import { createCredentialService } from "./credential-service.ts";

test("configuring stores the key and announces that credentials changed", async () => {
  const calls: string[] = [];
  const service = createCredentialService({
    onChanged: () => calls.push("changed"),
    setApiKey: async (providerId, apiKey) => {
      calls.push(`${providerId}:${apiKey}`);
    },
  });

  assert.deepEqual(await service.configure("test", "secret"), {
    success: true,
    notice: "test is configured",
  });
  assert.deepEqual(calls, ["test:secret", "changed"]);
});

test("a failed configuration reports the reason without announcing a change", async () => {
  let changes = 0;
  const service = createCredentialService({
    onChanged: () => {
      changes += 1;
    },
    setApiKey: async () => {
      throw new Error("login failed");
    },
  });

  assert.deepEqual(await service.configure("test", "secret"), {
    success: false,
    notice: "could not configure: login failed",
  });
  assert.equal(changes, 0);
});

test("removing clears the credential before announcing the change", async () => {
  const calls: string[] = [];
  const service = createCredentialService({
    onChanged: () => calls.push("changed"),
    clearCredential: async (providerId) => {
      calls.push(`clear:${providerId}`);
    },
  });

  assert.deepEqual(await service.remove("test"), {
    success: true,
    notice: "test is no longer configured",
  });
  assert.deepEqual(calls, ["clear:test", "changed"]);
});

test("listing delegates to the credential store", async () => {
  const providers = [{ id: "test", name: "Test", configured: true }];
  const service = createCredentialService({
    onChanged: () => {},
    listProviders: async () => providers,
  });

  assert.equal(await service.list(), providers);
});
