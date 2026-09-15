import { test } from "node:test";
import assert from "node:assert/strict";
import { type ProjectTrustRequest, createProjectTrustGate } from "./project-trust-gate.ts";

test("a remembered decision passes through without asking", async () => {
  const gate = createProjectTrustGate<string>({
    inspect: () => ({ required: true, decision: true, resources: [".agents/skills"] }),
    remember: () => assert.fail("an existing decision must not be written again"),
    request: () => assert.fail("an existing decision must not ask"),
  });

  assert.deepEqual(await gate.ensure("C:/work", "client"), {
    proceed: true,
    projectTrusted: true,
  });
});

test("an undecided project waits for and remembers its requesting client's answer", async () => {
  let request: ProjectTrustRequest | undefined;
  const remembered: Array<[string, boolean]> = [];
  const gate = createProjectTrustGate<string>({
    inspect: () => ({ required: true, decision: null, resources: [".agents/skills"] }),
    remember: (cwd, trusted) => remembered.push([cwd, trusted]),
    request: (requester, value) => {
      assert.equal(requester, "client-a");
      request = value;
    },
  });

  const pending = gate.ensure("C:/work", "client-a");
  assert.equal(request?.cwd, "C:/work");
  assert.equal(gate.respond("client-b", request!.requestId, true), false);
  assert.equal(gate.respond("client-a", request!.requestId, true), true);

  assert.deepEqual(await pending, { proceed: true, projectTrusted: true });
  assert.deepEqual(remembered, [["C:/work", true]]);
});

test("disconnecting the answering client cancels an undecided start", async () => {
  const gate = createProjectTrustGate<string>({
    inspect: () => ({ required: true, decision: null, resources: [".pi/skills"] }),
    remember: () => assert.fail("a disconnect must not save a decision"),
    request: () => {},
  });

  const pending = gate.ensure("C:/work", "client");
  gate.cancel("client");

  assert.deepEqual(await pending, { proceed: false });
});
