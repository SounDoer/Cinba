import assert from "node:assert/strict";
import test from "node:test";
import {
  CORE_CAPABILITIES,
  CORE_PROTOCOL_VERSION,
  assessCoreCompatibility,
  parseCoreHello,
} from "./compatibility.ts";

const HELLO = {
  productVersion: "0.1.0",
  revision: "a".repeat(40),
  protocolVersion: CORE_PROTOCOL_VERSION,
  capabilities: [...CORE_CAPABILITIES],
};

test("parses an exact Core product and protocol identity", () => {
  assert.deepEqual(parseCoreHello(HELLO), HELLO);
  assert.equal(parseCoreHello({ ...HELLO, productVersion: "latest" }), undefined);
  assert.equal(parseCoreHello({ ...HELLO, revision: "main" }), undefined);
  assert.equal(parseCoreHello({ ...HELLO, protocolVersion: 0 }), undefined);
  assert.equal(parseCoreHello({ ...HELLO, capabilities: ["unknown"] }), undefined);
  assert.equal(parseCoreHello({ ...HELLO, extra: true }), undefined);
  assert.equal(parseCoreHello({ ...HELLO, capabilities: ["sessions", "sessions"] }), undefined);
});

test("adjacent product releases connect when their protocol and needs match", () => {
  assert.deepEqual(
    assessCoreCompatibility({ ...HELLO, productVersion: "0.2.0" }, { capabilities: ["sessions"] }),
    { compatible: true },
  );
  assert.deepEqual(
    assessCoreCompatibility({ ...HELLO, productVersion: "0.0.9" }, { capabilities: ["sessions"] }),
    { compatible: true },
  );
});

test("protocol and required capability mismatches fail explicitly", () => {
  assert.deepEqual(assessCoreCompatibility({ ...HELLO, protocolVersion: 2 }), {
    compatible: false,
    reason: "protocol",
    detail: "Core protocol 2 is incompatible with client protocol 1",
  });
  assert.deepEqual(
    assessCoreCompatibility(
      { ...HELLO, capabilities: ["sessions"] },
      { capabilities: ["credentials"] },
    ),
    {
      compatible: false,
      reason: "capability",
      detail: "Core does not provide required capability credentials",
    },
  );
});
